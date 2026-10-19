/**
 * Minimal Gmail REST client for Google Voice co-pilot mode: read the Voice
 * notification emails, label them processed, and email the owner. Uses an
 * OAuth refresh token for the owner's own Google account (see `npm run gmail -- auth`).
 */

export interface MailMessage {
  id: string;
  threadId: string;
  from: string; // raw From header, e.g. "(706) 555-1234" <1706...@txt.voice.google.com>
  subject: string;
  date: Date;
  text: string; // plain-text body
}

export interface Gmail {
  /** Ids of Voice notification emails not yet labelled processed. */
  listUnprocessed(): Promise<string[]>;
  get(id: string): Promise<MailMessage>;
  markProcessed(id: string): Promise<void>;
  send(to: string, subject: string, text: string): Promise<void>;
}

export const PROCESSED_LABEL = "freeflow-processed";
export const VOICE_QUERY = `from:(voice-noreply@google.com OR txt.voice.google.com) newer_than:2d -label:${PROCESSED_LABEL}`;

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

function b64urlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function header(headers: { name: string; value: string }[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h\d|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prefer the text/plain part; fall back to stripped HTML. */
export function bodyText(payload: any): string {
  let plain = "";
  let html = "";
  const walk = (p: any) => {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = b64urlDecode(p.body.data);
    if (p.mimeType === "text/html" && p.body?.data && !html) html = b64urlDecode(p.body.data);
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  return (plain || htmlToText(html)).replace(/\r\n/g, "\n").trim();
}

/** RFC 2047-encode a header value only when it contains non-ASCII characters. */
function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

export class GmailApi implements Gmail {
  private token: { value: string; expires: number } | null = null;
  private labelId: string | null = null;

  constructor(private creds: { clientId: string; clientSecret: string; refreshToken: string; address: string }) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires - 60_000) return this.token.value;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`Gmail token refresh failed (${res.status}): ${await res.text()}`);
    const j: any = await res.json();
    this.token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
    return this.token.value;
  }

  private async call(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Gmail ${init.method ?? "GET"} ${path} failed (${res.status}): ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  private async processedLabel(): Promise<string> {
    if (this.labelId) return this.labelId;
    const { labels } = await this.call("/labels");
    const found = (labels ?? []).find((l: any) => l.name === PROCESSED_LABEL);
    this.labelId = found
      ? found.id
      : (await this.call("/labels", { method: "POST", body: JSON.stringify({ name: PROCESSED_LABEL, labelListVisibility: "labelShow", messageListVisibility: "show" }) })).id;
    return this.labelId!;
  }

  /** Most recent message ids for a Gmail search (newest first). */
  async search(q: string, max = 10): Promise<string[]> {
    const j = await this.call(`/messages?${new URLSearchParams({ q, maxResults: String(max) })}`);
    return (j.messages ?? []).map((m: any) => m.id);
  }

  async listUnprocessed(): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ q: VOICE_QUERY, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
      const j = await this.call(`/messages?${q}`);
      for (const m of j.messages ?? []) ids.push(m.id);
      pageToken = j.nextPageToken;
    } while (pageToken);
    return ids.reverse(); // oldest first
  }

  async get(id: string): Promise<MailMessage> {
    const m = await this.call(`/messages/${id}?format=full`);
    const h = m.payload?.headers;
    return {
      id: m.id,
      threadId: m.threadId,
      from: header(h, "From"),
      subject: header(h, "Subject"),
      date: new Date(Number(m.internalDate)),
      text: bodyText(m.payload),
    };
  }

  async markProcessed(id: string): Promise<void> {
    await this.call(`/messages/${id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: [await this.processedLabel()] }) });
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    const mime = [
      `From: ${this.creds.address}`,
      `To: ${to}`,
      `Subject: ${encodeHeader(subject)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(text, "utf8").toString("base64"),
    ].join("\r\n");
    const raw = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await this.call("/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
  }
}

/** In-memory Gmail for tests and the simulator. */
export class FakeGmail implements Gmail {
  inbox: (MailMessage & { processed?: boolean })[] = [];
  sent: { to: string; subject: string; text: string }[] = [];
  private n = 0;

  deliver(m: Omit<MailMessage, "id" | "threadId" | "date"> & { date?: Date }): string {
    const id = `gm${++this.n}`;
    this.inbox.push({ id, threadId: id, date: m.date ?? new Date(), ...m });
    return id;
  }
  async listUnprocessed() {
    return this.inbox.filter((m) => !m.processed).map((m) => m.id);
  }
  async get(id: string) {
    const m = this.inbox.find((x) => x.id === id);
    if (!m) throw new Error(`no message ${id}`);
    return m;
  }
  async markProcessed(id: string) {
    const m = this.inbox.find((x) => x.id === id);
    if (m) m.processed = true;
  }
  async send(to: string, subject: string, text: string) {
    this.sent.push({ to, subject, text });
  }
}
