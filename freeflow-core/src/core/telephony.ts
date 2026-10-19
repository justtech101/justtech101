import twilio from "twilio";

export interface SendResult {
  sid: string;
  status: string;
}

/** Thin seam over the SMS provider so flows never import Twilio directly. */
export interface Telephony {
  sendSms(to: string, body: string, opts?: { statusCallback?: string }): Promise<SendResult>;
}

export class TwilioTelephony implements Telephony {
  private client: ReturnType<typeof twilio>;

  constructor(accountSid: string, authToken: string, private from: string) {
    this.client = twilio(accountSid, authToken);
  }

  async sendSms(to: string, body: string, opts: { statusCallback?: string } = {}): Promise<SendResult> {
    const msg = await this.client.messages.create({
      to,
      from: this.from,
      body,
      statusCallback: opts.statusCallback,
    });
    return { sid: msg.sid, status: msg.status };
  }
}

/** Google Voice co-pilot mode: there is no automated SMS path at all. */
export class NoTelephony implements Telephony {
  async sendSms(): Promise<SendResult> {
    throw new Error("Automated SMS is disabled in Google Voice mode (CHANNEL=google_voice)");
  }
}

/** In-memory provider for tests and local runs without Twilio. */
export class FakeTelephony implements Telephony {
  sent: { to: string; body: string; sid: string }[] = [];
  /** Numbers that fail like a landline / non-SMS number does on Twilio (error 21614). */
  failNumbers = new Set<string>();
  private n = 0;

  async sendSms(to: string, body: string): Promise<SendResult> {
    if (this.failNumbers.has(to)) {
      const err: any = new Error(`'To' number ${to} is not a valid mobile number`);
      err.code = 21614;
      throw err;
    }
    const sid = `SMfake${++this.n}`;
    this.sent.push({ to, body, sid });
    return { sid, status: "queued" };
  }

  to(number: string) {
    return this.sent.filter((m) => m.to === number);
  }
}

/** Verifies the X-Twilio-Signature header for a webhook request. */
export function validTwilioSignature(authToken: string, signature: string | undefined, url: string, params: Record<string, string>): boolean {
  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}
