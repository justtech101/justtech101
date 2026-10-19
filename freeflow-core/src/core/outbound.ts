import { draftForOwner } from "./copilot.js";
import { isCopilot, type Deps } from "./deps.js";
import { alertOwner } from "./notify.js";
import { prettyPhone } from "./phone.js";
import {
  getMessageByKey, insertMessage, isGloballyPaused, logEvent, updateLead, updateMessage, type Lead, type Message,
} from "./store.js";

export type SendOutcome =
  | { ok: true; message: Message }
  | { ok: false; reason: "opted_out" | "paused" | "duplicate" | "failed"; error?: string };

/**
 * The only path that texts a lead. It enforces, for every system:
 *  - STOP is permanent: opted-out numbers are never messaged again;
 *  - "pause everything" holds all automated sends;
 *  - idempotency: the message row (with its unique key) is written BEFORE the
 *    provider call, so a retried job or a restart can never double-text. If a
 *    previous attempt is in an unknown state we refuse and alert, rather than
 *    risk a duplicate.
 * Every send is logged in `messages`; failures are logged in `events`.
 */
export async function sendToLead(
  deps: Deps,
  lead: Lead,
  body: string,
  opts: { kind: string; idempotencyKey?: string; bypassPause?: boolean },
): Promise<SendOutcome> {
  const now = deps.clock();
  if (lead.opted_out_at) {
    await logEvent(deps.db, lead.id, "blocked_send", `opted out; not sending ${opts.kind}`, now);
    return { ok: false, reason: "opted_out" };
  }
  if (!opts.bypassPause && (await isGloballyPaused(deps.db))) {
    await logEvent(deps.db, lead.id, "blocked_send", `automation paused; not sending ${opts.kind}`, now);
    return { ok: false, reason: "paused" };
  }

  let row = await insertMessage(deps.db, {
    lead_id: lead.id,
    direction: "outbound",
    channel: "sms",
    body,
    at: now,
    kind: opts.kind,
    status: "sending",
    idempotency_key: opts.idempotencyKey ?? null,
  });
  if (!row) {
    const prior = opts.idempotencyKey ? await getMessageByKey(deps.db, opts.idempotencyKey) : null;
    if (prior?.status === "failed") {
      // The provider rejected the earlier attempt, so nothing reached the lead: safe to retry.
      await updateMessage(deps.db, prior.id, { status: "sending" });
      row = { ...prior, id: Number(prior.id), lead_id: Number(prior.lead_id), status: "sending" };
    } else if (prior?.status === "sending") {
      await logEvent(deps.db, lead.id, "error", `send ${opts.idempotencyKey} found in unknown state after restart; not resending`, now);
      await alertOwner(deps, `Check ${prettyPhone(lead.phone)}: a ${opts.kind} text may or may not have gone out (service restarted mid-send). Not resending.`, lead.id);
      return { ok: false, reason: "duplicate" };
    } else {
      return { ok: false, reason: "duplicate" };
    }
  }

  if (isCopilot(deps)) {
    // Google Voice: a person sends it. Email the draft; the owner's "I sent it" link marks it sent.
    try {
      await draftForOwner(deps, lead, row.id, body, opts.kind);
      await updateMessage(deps.db, row.id, { status: "drafted" });
      await updateLead(deps.db, lead.id, { last_contact_at: now });
      return { ok: true, message: { ...row, status: "drafted" } };
    } catch (err: any) {
      // A failed draft is a Gmail problem, not an undeliverable number: throw so the caller
      // retries (the Voice email stays unlabelled; a job backs off). The keyed row makes the retry safe.
      const error = err?.message ?? String(err);
      await updateMessage(deps.db, row.id, { status: "failed", error });
      await logEvent(deps.db, lead.id, "error", `draft email failed (${opts.kind}): ${error}`, now);
      throw new Error(`draft email failed: ${error}`);
    }
  }

  try {
    const res = await deps.telephony.sendSms(lead.phone, body, {
      statusCallback: `${deps.env.PUBLIC_BASE_URL}/webhooks/sms-status`,
    });
    await updateMessage(deps.db, row.id, { status: "sent", provider_sid: res.sid });
    await updateLead(deps.db, lead.id, { last_contact_at: now });
    return { ok: true, message: { ...row, status: "sent", provider_sid: res.sid } };
  } catch (err: any) {
    const error = `${err?.code ?? ""} ${err?.message ?? err}`.trim();
    await updateMessage(deps.db, row.id, { status: "failed", error });
    await logEvent(deps.db, lead.id, "error", `sms send failed (${opts.kind}): ${error}`, now);
    return { ok: false, reason: "failed", error };
  }
}

/** Twilio's own STOP handling returns 21610 — treat it as an opt-out we must record. */
export function isOptOutError(error: string | undefined): boolean {
  return !!error && /\b21610\b/.test(error);
}
