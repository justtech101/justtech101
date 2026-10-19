import { z } from "zod";
import { isCopilot, type Deps } from "../core/deps.js";
import { factsBlock } from "../core/facts.js";
import { guardReply } from "../core/guard.js";
import { cancelLeadJobs } from "../core/jobs.js";
import { alertOwner } from "../core/notify.js";
import { isOptOutError, sendToLead } from "../core/outbound.js";
import { normalizePhone, prettyPhone } from "../core/phone.js";
import { loadPrompt, render, variant } from "../core/prompts.js";
import { insertMessage, logEvent, updateLead, upsertLead, type Lead } from "../core/store.js";
import { isOpen, nextOpenText } from "../core/time.js";
import { armFollowup } from "./followup.js";
import { smsHistory } from "./receptionist.js";

/** System 1: missed-call text-back. */

export const TextbackSchema = z.object({
  reply: z.string(),
  name: z.string().nullable(),
  need: z.string().nullable(),
  low_signal: z.boolean(),
  wants_human: z.boolean(),
  upset: z.boolean(),
});

interface TextbackState {
  exchanges: number;
  low_signal: number;
  closed_reason?: string;
}

function t(deps: Deps, key: string, extra: Record<string, string | null> = {}): string {
  return render(variant(loadPrompt("textback"), key, deps.env.CHANNEL), {
    business_name: deps.config.business_name,
    owner_name: deps.config.owner_name,
    ...extra,
  });
}

export function openerText(deps: Deps): string {
  const now = deps.clock();
  let body = t(deps, "opener");
  if (isOpen(deps.config, now) === false) {
    const open = nextOpenText(deps.config, now);
    if (open) body += ` ${t(deps, "after_hours", { open_time: open })}`;
  }
  return body;
}

export type MissedCallResult = "texted" | "duplicate" | "opted_out" | "owned" | "send_failed" | "paused" | "anonymous";

/**
 * A call to the business number ended unanswered. Text the caller within
 * seconds — unless they already have an open thread from the last 24 hours.
 */
export async function handleMissedCall(deps: Deps, input: { from: string; callSid?: string }): Promise<MissedCallResult> {
  const now = deps.clock();
  const phone = normalizePhone(input.from);
  if (!phone) {
    await logEvent(deps.db, null, "missed_call", `anonymous/blocked caller (${input.from || "no caller ID"})`, now);
    await alertOwner(deps, `Missed call from a blocked/unknown number — can't text back.`);
    return "anonymous";
  }
  let { lead } = await upsertLead(deps.db, { phone, source: "missed_call", consent_source: "inbound_call" }, now);
  await logEvent(deps.db, lead.id, "missed_call", input.callSid ?? null, now);

  if (lead.opted_out_at) {
    await alertOwner(deps, `Missed call from ${prettyPhone(phone)} (opted out of texts — call them back directly).`, lead.id);
    return "opted_out";
  }
  if (lead.status === "human" || lead.status === "booked") {
    await alertOwner(deps, `Missed call from ${lead.name ?? prettyPhone(phone)} (${prettyPhone(phone)}) — a lead you own. No auto-text sent.`, lead.id);
    return "owned";
  }
  const dedupeMs = deps.config.textback.dedupe_hours * 3_600_000;
  if (lead.thread_opened_at && now.getTime() - new Date(lead.thread_opened_at).getTime() < dedupeMs) {
    await logEvent(deps.db, lead.id, "repeat_missed_call", "open thread in last 24h; no duplicate opener", now);
    return "duplicate";
  }

  const res = await sendToLead(deps, lead, openerText(deps), {
    kind: "opener",
    idempotencyKey: `opener:${input.callSid ?? `${lead.id}:${now.toISOString()}`}`,
  });
  if (!res.ok) {
    if (res.reason === "duplicate") return "duplicate";
    if (res.reason === "paused") {
      await alertOwner(deps, `Missed call from ${prettyPhone(phone)} (automation paused — no text sent).`, lead.id);
      return "paused";
    }
    if (res.reason === "failed" && isOptOutError(res.error)) {
      await updateLead(deps.db, lead.id, { opted_out_at: now, status: "closed" });
      await logEvent(deps.db, lead.id, "stop", "carrier reports number opted out (21610)", now);
    }
    await alertOwner(deps, `Missed call from ${prettyPhone(phone)} — couldn't text back (landline or non-SMS number). Please call them.`, lead.id);
    return "send_failed";
  }

  const state: TextbackState = { exchanges: 0, low_signal: 0 };
  lead = await updateLead(deps.db, lead.id, {
    flow: "textback",
    flow_state: state,
    thread_opened_at: now,
    status: lead.status === "closed" ? "new" : lead.status,
  });
  // In Google Voice mode the opener draft email *is* the alert.
  if (deps.config.textback.alert_on_missed_call && !isCopilot(deps)) {
    await alertOwner(deps, `Missed call: ${lead.name ?? prettyPhone(phone)} ${lead.name ? prettyPhone(phone) : ""} — text-back sent.`.replace(/\s+—/, " —"), lead.id);
  }
  await armFollowup(deps, lead);
  return "texted";
}

/** Hand the thread to the owner: stop automation and send them everything we have. */
async function handToOwner(deps: Deps, lead: Lead, opts: { reply: string | null; alert: string; event: string }) {
  // In Google Voice mode the owner is the one replying, so no "I've passed this on" draft.
  if (opts.reply && !isCopilot(deps)) await sendToLead(deps, lead, opts.reply, { kind: "handoff_ack" });
  await updateLead(deps.db, lead.id, { status: "human", flow: null });
  await cancelLeadJobs(deps, lead.id, opts.event);
  await logEvent(deps.db, lead.id, "handoff", opts.event, deps.clock());
  await alertOwner(deps, opts.alert, lead.id);
}

function leadLine(lead: Lead, name: string | null, need: string | null) {
  return `${name ?? lead.name ?? "(no name)"} · ${prettyPhone(lead.phone)} · ${need ?? lead.need ?? "(need unknown)"}`;
}

/** An inbound text on an open text-back thread. */
export async function handleTextbackReply(deps: Deps, lead: Lead, body: string, opts: { prefix?: string; context?: string } = {}): Promise<void> {
  const now = deps.clock();
  const cfg = deps.config.textback;
  const prior = lead.flow_state as Partial<TextbackState>;
  const state: TextbackState = { ...prior, exchanges: prior.exchanges ?? 0, low_signal: prior.low_signal ?? 0 };
  state.exchanges++;

  const history = await smsHistory(deps, lead, opts.context ?? "(I called the business and nobody answered, then got this text)");
  let out: z.infer<typeof TextbackSchema>;
  try {
    out = await deps.ai.structured({
      system: render(variant(loadPrompt("textback"), "system", deps.env.CHANNEL), {
        business_name: deps.config.business_name,
        owner_name: deps.config.owner_name,
        facts: factsBlock(deps.config),
      }),
      messages: history,
      schema: TextbackSchema,
    });
  } catch (err: any) {
    await logEvent(deps.db, lead.id, "error", `AI error in text-back: ${err?.message ?? err}`, now);
    await handToOwner(deps, lead, {
      reply: t(deps, "error_fallback"),
      alert: `AI error on text-back thread — please take over. ${leadLine(lead, null, null)}. They said: "${body}"`,
      event: "ai_error",
    });
    return;
  }

  const name = out.name ?? lead.name;
  const need = out.need ?? lead.need;
  lead = await updateLead(deps.db, lead.id, {
    name,
    need,
    status: lead.status === "new" ? "engaged" : lead.status,
    flow_state: state,
  });

  if (out.upset || out.wants_human) {
    await handToOwner(deps, lead, {
      reply: t(deps, "handoff_ack"),
      alert: `HANDOFF (${out.upset ? "customer upset" : "asked for you"}): ${leadLine(lead, name, need)}. Last msg: "${body}"`,
      event: out.upset ? "upset" : "asked_for_human",
    });
    return;
  }

  if (name && need) {
    await handToOwner(deps, lead, {
      reply: t(deps, "capture_ack", { name }),
      alert: `New lead (text-back): ${leadLine(lead, name, need)}`,
      event: "captured",
    });
    await logEvent(deps.db, lead.id, "captured", `name=${name}; need=${need}`, now);
    return;
  }

  if (out.low_signal) {
    state.low_signal++;
    if (state.low_signal > cfg.max_low_signal_attempts) {
      // Spam / wrong number / one-word replies: close quietly.
      await updateLead(deps.db, lead.id, { status: "closed", flow: null, flow_state: { ...state, closed_reason: "low_signal" } });
      await cancelLeadJobs(deps, lead.id, "low-signal thread closed");
      await logEvent(deps.db, lead.id, "closed", "low-signal replies; thread closed quietly", now);
      return;
    }
  }

  if (state.exchanges >= cfg.max_exchanges) {
    await handToOwner(deps, lead, {
      reply: t(deps, "handoff_ack"),
      alert: `Text-back thread stalled after ${state.exchanges} exchanges — please take over: ${leadLine(lead, name, need)}. Last msg: "${body}"`,
      event: "stalled",
    });
    return;
  }

  const g = guardReply(out.reply, deps.config, deps.env.CHANNEL);
  if (g.violations.length) {
    await logEvent(deps.db, lead.id, "guardrail", `text-back reply blocked: ${g.violations.join("; ")} | original: ${out.reply}`, now);
  }
  lead = await updateLead(deps.db, lead.id, { flow_state: state });
  await sendToLead(deps, lead, opts.prefix ? `${opts.prefix} ${g.text}` : g.text, { kind: "ai_reply" });
  await armFollowup(deps, lead);
}

/**
 * A voicemail (Google Voice mode, from the voicemail email). With a transcript,
 * the first reply answers what they actually said; without one it is a plain
 * missed call.
 */
export async function handleVoicemail(deps: Deps, input: { phone: string; transcript: string; sid: string }): Promise<"handled" | "duplicate" | MissedCallResult> {
  const now = deps.clock();
  let { lead } = await upsertLead(deps.db, { phone: input.phone, source: "missed_call", consent_source: "inbound_call" }, now);
  const row = await insertMessage(deps.db, {
    lead_id: lead.id, direction: "inbound", channel: "voice-transcript", kind: "voicemail", status: "received",
    body: input.transcript || "(voicemail — no transcript)", at: now, provider_sid: input.sid,
  });
  if (!row) return "duplicate";
  await logEvent(deps.db, lead.id, "voicemail", input.transcript || "(no transcript)", now);
  if (!input.transcript) return handleMissedCall(deps, { from: input.phone, callSid: input.sid });

  const who = `${lead.name ?? prettyPhone(lead.phone)}`;
  if (lead.opted_out_at || lead.status === "human" || lead.status === "booked") {
    await alertOwner(deps, `Voicemail from ${who}${lead.opted_out_at ? " (opted out of texts — call them)" : " (a lead you own)"}: "${input.transcript}"`, lead.id);
    return "owned";
  }
  if (lead.flow) {
    // Mid-conversation: the voicemail is just their next message.
    const { processInboundSms } = await import("./inbound.js");
    await processInboundSms(deps, lead, input.transcript);
    return "handled";
  }
  lead = await updateLead(deps.db, lead.id, {
    flow: "textback",
    flow_state: { exchanges: 0, low_signal: 0 },
    thread_opened_at: now,
    status: lead.status === "closed" ? "new" : lead.status,
  });
  await logEvent(deps.db, lead.id, "missed_call", `voicemail ${input.sid}`, now);
  await handleTextbackReply(deps, lead, input.transcript, {
    prefix: t(deps, "voicemail_ack"),
    context: "(I called the business, nobody answered, and I left this voicemail)",
  });
  return "handled";
}
