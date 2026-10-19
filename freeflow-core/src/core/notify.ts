import nodemailer from "nodemailer";
import { actionUrl } from "./actions.js";
import { isCopilot, type Deps } from "./deps.js";
import { getLead, logEvent, setSetting } from "./store.js";

export interface Mailer {
  send(subject: string, text: string): Promise<boolean>;
}

export class SmtpMailer implements Mailer {
  private transport;
  constructor(private opts: { host: string; port: number; user: string; password: string; from: string; to: string }) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.port === 465,
      auth: opts.user ? { user: opts.user, pass: opts.password } : undefined,
    });
  }
  async send(subject: string, text: string): Promise<boolean> {
    await this.transport.sendMail({ from: this.opts.from, to: this.opts.to, subject, text });
    return true;
  }
}

/** No SMTP configured: the SMS summary still goes out; email is skipped. */
export class NullMailer implements Mailer {
  sent: { subject: string; text: string }[] = [];
  async send(subject: string, text: string): Promise<boolean> {
    this.sent.push({ subject, text });
    return false;
  }
}

export function ownerEmail(deps: Deps): string {
  return deps.env.OWNER_ALERT_EMAIL || deps.env.GMAIL_ADDRESS;
}

/**
 * Deliver a message to the owner on their channel: SMS to the alert number
 * (Twilio mode) or email (Google Voice co-pilot mode). Throws on failure.
 */
export async function sendToOwner(deps: Deps, text: string, opts: { subject?: string; leadId?: number | null } = {}): Promise<boolean> {
  if (isCopilot(deps)) {
    const to = ownerEmail(deps);
    if (!deps.gmail || !to) return false;
    const lead = opts.leadId ? await getLead(deps.db, opts.leadId) : null;
    const links = lead
      ? [
          "",
          `Pause this lead (I'll handle it): ${actionUrl(deps, { do: "pause", lead: lead.id })}`,
          `Full log: npm run cli -- log ${lead.phone}`,
        ].join("\n")
      : "";
    const subject = opts.subject ?? `FreeFlow: ${text.split("\n")[0].slice(0, 90)}`;
    await deps.gmail.send(to, subject, `${text}${links}`);
    return true;
  }
  if (!deps.env.OWNER_ALERT_NUMBER) return false;
  await deps.telephony.sendSms(deps.env.OWNER_ALERT_NUMBER, text);
  return true;
}

/**
 * Alert Jesse. Alerts are the one thing that must never fail silently: every
 * alert is logged as an event, and a failed alert is logged loudly too.
 * The lead the alert is about becomes the default target for Jesse's reply
 * commands (e.g. replying "PAUSE" with no number).
 */
export async function alertOwner(deps: Deps, text: string, leadId: number | null = null, opts: { subject?: string } = {}): Promise<boolean> {
  const now = deps.clock();
  const prefix = deps.env.DEPLOY_ENV === "production" ? "" : `[${deps.env.DEPLOY_ENV}] `;
  const body = `${prefix}${text}`;
  await logEvent(deps.db, leadId, "alert", body, now);
  if (leadId) await setSetting(deps.db, "last_alert_lead_id", leadId);
  try {
    const sent = await sendToOwner(deps, body, { leadId, subject: opts.subject && `${prefix}${opts.subject}` });
    if (!sent) {
      console.error(`[ALERT NOT SENT — no owner ${isCopilot(deps) ? "email/Gmail" : "OWNER_ALERT_NUMBER"} configured] ${body}`);
      await logEvent(deps.db, leadId, "error", "alert not sent: owner channel not configured", now);
    }
    return sent;
  } catch (err: any) {
    console.error(`[ALERT FAILED] ${body}`, err);
    await logEvent(deps.db, leadId, "error", `alert send failed: ${err?.message ?? err}`, now);
    return false;
  }
}
