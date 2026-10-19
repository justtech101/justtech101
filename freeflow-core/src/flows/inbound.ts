import type { Deps } from "../core/deps.js";
import { cancelLeadJobs } from "../core/jobs.js";
import { alertOwner } from "../core/notify.js";
import { sendToLead } from "../core/outbound.js";
import { normalizePhone, prettyPhone } from "../core/phone.js";
import { insertMessage, isGloballyPaused, logEvent, updateLead, upsertLead, type Lead } from "../core/store.js";
import { continueSmsIntake, startSmsIntake } from "./receptionist.js";
import { handleOwnerSms } from "./owner.js";
import { handleTextbackReply } from "./textback.js";

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);
const HUMAN_WORDS = new Set(["HUMAN", "PERSON", "AGENT", "REPRESENTATIVE", "OPERATOR"]);

function keyword(body: string): string {
  return body.trim().toUpperCase().replace(/[^A-Z]/g, "");
}

export interface InboundSms {
  from: string;
  body: string;
  sid: string;
}

/**
 * Record an inbound text. Runs before the webhook is acknowledged so nothing
 * received is ever lost. Returns null for a duplicate delivery (same MessageSid).
 */
export async function recordInboundSms(deps: Deps, sms: InboundSms): Promise<{ lead: Lead } | { owner: true } | null> {
  const now = deps.clock();
  const phone = normalizePhone(sms.from);
  if (!phone) return null;
  if (deps.env.OWNER_ALERT_NUMBER && phone === normalizePhone(deps.env.OWNER_ALERT_NUMBER)) return { owner: true };
  const { lead } = await upsertLead(deps.db, { phone, source: "sms", consent_source: "inbound_sms" }, now);
  const row = await insertMessage(deps.db, {
    lead_id: lead.id, direction: "inbound", channel: "sms", body: sms.body, at: now, status: "received", provider_sid: sms.sid,
  });
  if (!row) return null;
  return { lead };
}

/** Route an inbound text (already recorded) to the right system. */
export async function processInboundSms(deps: Deps, lead: Lead, body: string): Promise<void> {
  const now = deps.clock();
  const kw = keyword(body);

  // STOP is honoured immediately across every system and recorded permanently.
  if (STOP_WORDS.has(kw)) {
    await updateLead(deps.db, lead.id, { opted_out_at: now, status: "closed", flow: null });
    await cancelLeadJobs(deps, lead.id, "STOP");
    await logEvent(deps.db, lead.id, "stop", `customer texted "${body.trim()}"`, now);
    await alertOwner(deps, `${lead.name ?? prettyPhone(lead.phone)} texted STOP — opted out of all texts.`, lead.id);
    return; // Twilio sends the carrier-required opt-out confirmation itself.
  }
  if (lead.opted_out_at) {
    if (START_WORDS.has(kw)) {
      await updateLead(deps.db, lead.id, { opted_out_at: null, status: "human" });
      await logEvent(deps.db, lead.id, "opt_in", `customer texted "${body.trim()}"`, now);
      await alertOwner(deps, `${prettyPhone(lead.phone)} opted back in (texted ${kw}). Lead is yours: "${body}"`, lead.id);
    } else {
      await logEvent(deps.db, lead.id, "note", "message from opted-out number; no automated reply", now);
    }
    return;
  }

  // Reply = stop, for the follow-up engine: cancel every pending follow-up the moment they reply.
  await cancelLeadJobs(deps, lead.id, "lead replied", ["followup_step"]);

  if (HUMAN_WORDS.has(kw)) {
    await sendToLead(deps, lead, `Got it — I've let ${deps.config.owner_name} know, and you'll hear back personally soon.`, { kind: "handoff_ack" });
    await updateLead(deps.db, lead.id, { status: "human", flow: null });
    await cancelLeadJobs(deps, lead.id, "HUMAN requested");
    await logEvent(deps.db, lead.id, "handoff", `customer texted "${body.trim()}"`, now);
    await alertOwner(deps, `HANDOFF: ${lead.name ?? ""} ${prettyPhone(lead.phone)} asked for a human. Last msg: "${body}"`.replace(/\s+/g, " "), lead.id);
    return;
  }

  // A reply after the follow-up sequence started: the machine steps aside, Jesse steps in.
  if (lead.followup_started_at && lead.status !== "human") {
    await updateLead(deps.db, lead.id, { status: "human", flow: null });
    await cancelLeadJobs(deps, lead.id, "replied to follow-up");
    await logEvent(deps.db, lead.id, "handoff", "replied to follow-up sequence", now);
    await alertOwner(deps, `${lead.name ?? prettyPhone(lead.phone)} replied to follow-up (${lead.need ?? "need unknown"}): "${body}" — it's yours.`, lead.id);
    return;
  }

  // Human-owned / booked / closed threads get no automation; Jesse sees every message.
  if (lead.status === "human" || lead.status === "booked") {
    await alertOwner(deps, `${lead.name ?? prettyPhone(lead.phone)} (${prettyPhone(lead.phone)}) texted: "${body}"`, lead.id);
    return;
  }
  if (lead.status === "closed") {
    if (lead.flow_state?.closed_reason === "low_signal") {
      await logEvent(deps.db, lead.id, "note", "message on quietly closed low-signal thread", now);
      return;
    }
    await updateLead(deps.db, lead.id, { status: "human" });
    await logEvent(deps.db, lead.id, "handoff", "closed lead re-engaged", now);
    await alertOwner(deps, `${lead.name ?? prettyPhone(lead.phone)} re-engaged after being closed: "${body}" — it's yours.`, lead.id);
    return;
  }
  if (await isGloballyPaused(deps.db)) {
    await alertOwner(deps, `(Automation paused) ${prettyPhone(lead.phone)} texted: "${body}"`, lead.id);
    return;
  }

  if (lead.flow === "textback") return handleTextbackReply(deps, lead, body);
  if (lead.flow === "receptionist") return continueSmsIntake(deps, lead, body);
  return startSmsIntake(deps, lead, body);
}

export async function handleInboundSms(deps: Deps, sms: InboundSms): Promise<void> {
  const rec = await recordInboundSms(deps, sms);
  if (!rec) return;
  if ("owner" in rec) return handleOwnerSms(deps, sms.body);
  await processInboundSms(deps, rec.lead, sms.body);
}
