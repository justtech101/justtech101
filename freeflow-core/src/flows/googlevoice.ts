import type { Deps } from "../core/deps.js";
import type { MailMessage } from "../core/gmail.js";
import { alertOwner } from "../core/notify.js";
import { normalizePhone } from "../core/phone.js";
import { getSetting, logEvent, setSetting } from "../core/store.js";
import { parseVoiceEmail, type VoiceEvent } from "../core/voice-email.js";
import { handleInboundSms } from "./inbound.js";
import { handleMissedCall, handleVoicemail } from "./textback.js";

/**
 * Google Voice co-pilot inbound: every Voice notification email (text, missed
 * call, voicemail) is parsed and fed to the same flows the Twilio webhooks use.
 * Each email is processed once (Gmail label + message-id dedupe in the DB).
 */
export async function processVoiceEmail(deps: Deps, msg: MailMessage): Promise<VoiceEvent["kind"]> {
  const ev = parseVoiceEmail(msg, normalizePhone(deps.env.GOOGLE_VOICE_NUMBER));
  const sid = `gmail:${msg.id}`;
  switch (ev.kind) {
    case "sms":
      await handleInboundSms(deps, { from: ev.phone, body: ev.text, sid });
      break;
    case "missed_call":
      await handleMissedCall(deps, { from: ev.phone, callSid: sid });
      break;
    case "voicemail":
      await handleVoicemail(deps, { phone: ev.phone, transcript: ev.transcript, sid });
      break;
    case "unknown":
      // Fail loud: an email we can't read could be a customer we'd otherwise lose.
      await logEvent(deps.db, null, "error", `unreadable Google Voice email ${msg.id}: ${ev.reason}`, deps.clock());
      await alertOwner(deps, `I couldn't read a Google Voice email (${ev.reason}). Subject: "${msg.subject}". Please check Google Voice for it.`);
      break;
  }
  return ev.kind;
}

const failedOnce = new Set<string>();

/** One poll: process every unlabelled Voice email, oldest first. Returns how many were handled. */
export async function pollGoogleVoice(deps: Deps): Promise<number> {
  if (!deps.gmail) return 0;
  // On first start, don't act on old emails (that would text people from days ago).
  let since = await getSetting<string | null>(deps.db, "gv_since", null);
  if (!since) {
    since = deps.clock().toISOString();
    await setSetting(deps.db, "gv_since", since);
  }
  let n = 0;
  for (const id of await deps.gmail.listUnprocessed()) {
    const msg = await deps.gmail.get(id);
    try {
      if (msg.date >= new Date(since)) {
        await processVoiceEmail(deps, msg);
        n++;
      }
      await deps.gmail.markProcessed(id);
      failedOnce.delete(id);
    } catch (err: any) {
      // Leave it unlabelled so the next poll retries; alert once, not every 20 seconds.
      console.error(`[gv] processing ${id} failed`, err);
      await logEvent(deps.db, null, "error", `Google Voice email ${id} failed: ${err?.message ?? err}`, deps.clock());
      if (!failedOnce.has(id)) {
        failedOnce.add(id);
        await alertOwner(deps, `System error handling a Google Voice email ("${msg.subject}"). It will retry; check Google Voice meanwhile.`);
      }
    }
  }
  return n;
}

export function startGoogleVoicePoller(deps: Deps, intervalMs: number) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollGoogleVoice(deps);
    } catch (err) {
      console.error("[gv] poll failed", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(timer);
}
