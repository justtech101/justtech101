import { actionUrl } from "./actions.js";
import type { Deps } from "./deps.js";
import { ownerEmail } from "./notify.js";
import { prettyPhone } from "./phone.js";
import type { Lead } from "./store.js";

/** What each draft is for, in the owner's words. */
const PURPOSE: Record<string, string> = {
  opener: "Missed call — text them back now",
  ai_reply: "Reply in the text-back conversation",
  intake_question: "Next intake question",
  intake_close: "Wrap up the intake",
  error_fallback: "Holding reply (the AI had an error)",
  followup_step_1: "Follow-up 1 of 4 (they went quiet)",
  followup_step_2: "Follow-up 2 of 4",
  followup_step_3: "Follow-up 3 of 4",
  followup_step_4: "Follow-up 4 of 4 — last one, then the lead closes",
};

export const GOOGLE_VOICE_URL = "https://voice.google.com/u/0/messages";

/**
 * Google Voice co-pilot: instead of sending, email the owner the exact text to
 * send from Google Voice, with one-tap links. Google Voice's policy forbids
 * automated sending, so a person always presses send.
 */
export async function draftForOwner(deps: Deps, lead: Lead, messageId: number, body: string, kind: string): Promise<void> {
  if (!deps.gmail) throw new Error("Google Voice mode needs Gmail configured (GMAIL_* env vars)");
  const who = `${lead.name ? `${lead.name} ` : ""}${prettyPhone(lead.phone)}`;
  const purpose = PURPOSE[kind] ?? kind.replace(/_/g, " ");
  const prefix = deps.env.DEPLOY_ENV === "production" ? "" : `[${deps.env.DEPLOY_ENV}] `;
  const text = [
    `${purpose}.`,
    `Text this to ${who} from Google Voice:`,
    "",
    body,
    "",
    "———",
    `Open Google Voice: ${GOOGLE_VOICE_URL}`,
    `I sent it: ${actionUrl(deps, { do: "sent", lead: lead.id, message: messageId })}`,
    `Pause this lead (I'll handle it myself): ${actionUrl(deps, { do: "pause", lead: lead.id })}`,
    "",
    `Need: ${lead.need ?? "not known yet"}`,
    "Edit the wording if you like. Nothing is sent automatically.",
  ].join("\n");
  await deps.gmail.send(ownerEmail(deps), `${prefix}Text ${who}: ${body.slice(0, 60)}${body.length > 60 ? "…" : ""}`, text);
}
