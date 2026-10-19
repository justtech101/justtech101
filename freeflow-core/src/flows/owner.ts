import type { Deps } from "../core/deps.js";
import { sendToOwner } from "../core/notify.js";
import { sendToLead } from "../core/outbound.js";
import { prettyPhone } from "../core/phone.js";
import { logEvent, updateLead, type Lead } from "../core/store.js";
import { findLead, lastAlertedLead, pauseLead, resetLead, setGlobalPause, todaysQueue } from "./controls.js";

export const OWNER_HELP =
  "Commands: PAUSE [number] · RESET [number] · SAY [number] message · PAUSE ALL · RESUME ALL · QUEUE · HELP. " +
  "No number = the lead from your latest alert. Any other text pauses that lead.";

async function replyToOwner(deps: Deps, text: string) {
  await sendToOwner(deps, text);
}

/**
 * A text from Jesse's own number to the business number. Humans can always
 * break in: anything he sends pauses automation on a thread.
 */
export async function handleOwnerSms(deps: Deps, body: string): Promise<void> {
  const text = body.trim();
  const upper = text.toUpperCase();
  await logEvent(deps.db, null, "owner_command", text, deps.clock());

  if (upper === "HELP" || upper === "?") return replyToOwner(deps, OWNER_HELP);
  if (upper === "PAUSE ALL") {
    await setGlobalPause(deps, true, "owner sms");
    return replyToOwner(deps, "All automation paused. Text RESUME ALL to restart.");
  }
  if (upper === "RESUME ALL") {
    await setGlobalPause(deps, false, "owner sms");
    return replyToOwner(deps, "Automation resumed.");
  }
  if (upper === "QUEUE") {
    const q = await todaysQueue(deps);
    return replyToOwner(deps, q.length ? `Today's queue:\n${q.slice(0, 10).join("\n")}` : "Nothing queued for today.");
  }

  const m = /^(PAUSE|RESET|SAY)\b\s*(\+?[\d\-\s().]{7,}\d)?\s*([\s\S]*)$/i.exec(text);
  const command = m ? m[1].toUpperCase() : null;
  let lead: Lead | null = m?.[2] ? await findLead(deps, m[2]) : await lastAlertedLead(deps);
  if (m?.[2] && !lead) return replyToOwner(deps, `No lead found for ${m[2]}.`);
  if (!lead) return replyToOwner(deps, `No recent lead to apply that to. ${OWNER_HELP}`);

  if (command === "RESET") {
    await resetLead(deps, lead, "owner sms");
    return replyToOwner(deps, `Reset ${prettyPhone(lead.phone)}: status new, follow-up re-armed.`);
  }
  lead = await pauseLead(deps, lead, "owner sms");
  if (command === "SAY") {
    const msg = (m?.[3] ?? "").trim();
    if (!msg) return replyToOwner(deps, "SAY needs a message, e.g. SAY 7065550100 On my way!");
    const res = await sendToLead(deps, lead, msg, { kind: "owner_relay", bypassPause: true });
    await updateLead(deps.db, lead.id, { status: "human" });
    return replyToOwner(deps, res.ok ? `Sent to ${prettyPhone(lead.phone)}.` : `Not sent (${res.reason}).`);
  }
  const note = command === "PAUSE" ? "" : ` (Unrecognised text — ${OWNER_HELP})`;
  return replyToOwner(deps, `Paused ${lead.name ?? ""} ${prettyPhone(lead.phone)} — automation off, it's yours.${note}`.replace(/\s+/g, " "));
}
