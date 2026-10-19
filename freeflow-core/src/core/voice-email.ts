import { normalizePhone } from "./phone.js";
import type { MailMessage } from "./gmail.js";

/**
 * Turns a Google Voice notification email into an event. Google Voice has no
 * API, so these emails are the only machine-readable signal. The formats are not
 * documented: the parser keys off the subject line, takes the phone number from
 * the subject, the txt.voice.google.com sender address or the body (in that
 * order), and returns "unknown" — never a guess — when it can't tell.
 */
export type VoiceEvent =
  | { kind: "sms"; phone: string; text: string }
  | { kind: "missed_call"; phone: string }
  | { kind: "voicemail"; phone: string; transcript: string }
  | { kind: "unknown"; reason: string };

const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

// Lines that start Google's footer / chrome; everything from the first one on is dropped.
const FOOTER = [
  /^to respond to this text message/i,
  /^your account\b/i,
  /^help center\b/i,
  /^help forum\b/i,
  /^you received this (message|email|notification)/i,
  /^google llc/i,
  /^this email was sent to/i,
  /^change your email notification settings/i,
  /^play message/i,
  /^listen to (the )?(full )?(voicemail|message)/i,
  /^google voice$/i,
];

function cleanBody(text: string): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (FOOTER.some((re) => re.test(line))) break;
    if (/^<?https?:\/\/\S+>?$/.test(line)) continue; // bare links
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function phoneFrom(...sources: string[]): string | null {
  for (const s of sources) {
    const m = PHONE.exec(s);
    const n = m ? normalizePhone(m[0]) : null;
    if (n) return n;
  }
  return null;
}

/** txt.voice.google.com local parts hold both numbers (e.g. 17065551234.18033806153.xyz); pick the one that isn't ours. */
function phoneFromTxtAddress(from: string, ownNumber: string | null): string | null {
  const m = /([\w.]+)@txt\.voice\.google\.com/i.exec(from);
  if (!m) return null;
  const numbers = (m[1].match(/\d{10,11}/g) ?? []).map((d) => normalizePhone(d)).filter((x): x is string => !!x);
  return numbers.find((n) => n !== ownNumber) ?? null;
}

export function parseVoiceEmail(msg: Pick<MailMessage, "from" | "subject" | "text">, ownNumber: string | null): VoiceEvent {
  const subject = msg.subject.trim();
  const body = cleanBody(msg.text);
  const subjPhone = phoneFrom(subject);

  if (/^(new )?(text|group) message/i.test(subject) || /@txt\.voice\.google\.com/i.test(msg.from)) {
    if (/^new group message/i.test(subject)) return { kind: "unknown", reason: "group text (not handled automatically)" };
    const phone = subjPhone ?? phoneFromTxtAddress(msg.from, ownNumber);
    if (!phone) return { kind: "unknown", reason: "text message with no readable phone number" };
    if (!body) return { kind: "unknown", reason: "text message with an empty body (picture message?)" };
    return { kind: "sms", phone, text: body };
  }
  if (/missed call/i.test(subject)) {
    const phone = subjPhone ?? phoneFrom(body);
    return phone ? { kind: "missed_call", phone } : { kind: "unknown", reason: "missed call with no readable phone number" };
  }
  if (/voicemail/i.test(subject)) {
    const phone = subjPhone ?? phoneFrom(body);
    if (!phone) return { kind: "unknown", reason: "voicemail with no readable phone number" };
    // The transcript is the body minus a leading "Voicemail from ..." / "Transcript:" line.
    const transcript = body
      .split("\n")
      .filter((l) => !/^(new )?voicemail from\b/i.test(l) && !/^transcript:?$/i.test(l))
      .join(" ")
      .replace(/^transcript:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    const unavailable = /transcri(pt|ption)\s+(is\s+)?(not|un)\s?available/i.test(transcript);
    return { kind: "voicemail", phone, transcript: unavailable ? "" : transcript };
  }
  return { kind: "unknown", reason: `unrecognised subject "${subject}"` };
}
