import nodemailer from "nodemailer";
import type { Deps } from "./deps.js";
import { logEvent, setSetting } from "./store.js";

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

/**
 * Text Jesse. Alerts are the one thing that must never fail silently: every
 * alert is logged as an event, and a failed alert is logged loudly too.
 * The lead the alert is about becomes the default target for Jesse's reply
 * commands (e.g. replying "PAUSE" with no number).
 */
export async function alertOwner(deps: Deps, text: string, leadId: number | null = null): Promise<boolean> {
  const now = deps.clock();
  const prefix = deps.env.DEPLOY_ENV === "production" ? "" : `[${deps.env.DEPLOY_ENV}] `;
  const body = `${prefix}${text}`;
  await logEvent(deps.db, leadId, "alert", body, now);
  if (leadId) await setSetting(deps.db, "last_alert_lead_id", leadId);
  if (!deps.env.OWNER_ALERT_NUMBER) {
    console.error(`[ALERT NOT SENT — OWNER_ALERT_NUMBER unset] ${body}`);
    await logEvent(deps.db, leadId, "error", "alert not sent: OWNER_ALERT_NUMBER unset", now);
    return false;
  }
  try {
    await deps.telephony.sendSms(deps.env.OWNER_ALERT_NUMBER, body);
    return true;
  } catch (err: any) {
    console.error(`[ALERT FAILED] ${body}`, err);
    await logEvent(deps.db, leadId, "error", `alert send failed: ${err?.message ?? err}`, now);
    return false;
  }
}
