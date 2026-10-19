// Google Voice co-pilot mode: Voice notification emails in, drafts for the owner out.
// Google Voice forbids automated sending, so the core assertion everywhere: no SMS is ever sent.
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { htmlToText } from "../src/core/gmail.js";
import { parseVoiceEmail } from "../src/core/voice-email.js";
import { pollGoogleVoice } from "../src/flows/googlevoice.js";
import { sendDailySummary } from "../src/flows/summary.js";
import { CALLER, et, events, leadByPhone, makeCtx, resetDb, tb, type TestCtx } from "./helpers.js";

beforeEach(resetDb);

const GV = "+18033806153";
const OWNER_EMAIL = "jesse@example.com";
const GV_ENV = {
  CHANNEL: "google_voice",
  GMAIL_ADDRESS: OWNER_EMAIL,
  GOOGLE_VOICE_NUMBER: GV,
  ACTION_SECRET: "test-action-secret",
  PUBLIC_BASE_URL: "https://ff.test",
};
const FOOTER = `
YOUR ACCOUNT <https://voice.google.com> HELP CENTER <https://support.google.com/voice#topic=1707989> HELP FORUM <https://productforums.google.com/forum/#!forum/voice>
To respond to this text message, reply to this email or visit Google Voice.
You received this message because you are subscribed to Google Voice.
Google LLC 1600 Amphitheatre Parkway, Mountain View CA 94043 USA`;

const textEmail = (body: string, from = "(706) 555-1234") => ({
  from: `"${from} (SMS)" <18033806153.17065551234.Ab12Cd34@txt.voice.google.com>`,
  subject: `New text message from ${from}`,
  text: `${body}\n${FOOTER}`,
});
const missedEmail = (phone = "(706) 555-1234") => ({
  from: "Google Voice <voice-noreply@google.com>",
  subject: `New missed call from ${phone}`,
  text: `Missed call from ${phone} at 10:02 AM\n${FOOTER}`,
});
const voicemailEmail = (transcript: string, phone = "(706) 555-1234") => ({
  from: "Google Voice <voice-noreply@google.com>",
  subject: `New voicemail from ${phone} at 10:02 AM`,
  text: `${transcript}\nPlay message\nhttps://voice.google.com/u/0/voicemail\n${FOOTER}`,
});

async function gvCtx(at = et("2026-10-20 10:00")): Promise<TestCtx> {
  const ctx = await makeCtx({ env: GV_ENV, at });
  await pollGoogleVoice(ctx.deps); // first poll records the start time (backlog cut-off)
  ctx.advance(0.1);
  return ctx;
}
const drafts = (ctx: TestCtx) => ctx.gmail.sent.filter((m) => m.subject.startsWith("Text "));
const alerts = (ctx: TestCtx) => ctx.gmail.sent.filter((m) => !m.subject.startsWith("Text "));
const linkFrom = (text: string, label: string) => new RegExp(`${label}: (https://ff\\.test/a/\\S+)`).exec(text)![1].replace("https://ff.test", "");

describe("parsing Google Voice emails", () => {
  it("reads a text, stripping Google's footer", () => {
    expect(parseVoiceEmail(textEmail("Hi, my printer won't connect"), GV)).toEqual({ kind: "sms", phone: CALLER, text: "Hi, my printer won't connect" });
  });
  it("takes the number from the txt.voice.google.com address when the subject shows a contact name", () => {
    expect(parseVoiceEmail(textEmail("hey it's Maria", "Maria Lopez"), GV)).toMatchObject({ kind: "sms", phone: CALLER });
  });
  it("reads missed calls and voicemails (with and without a transcript)", () => {
    expect(parseVoiceEmail(missedEmail(), GV)).toEqual({ kind: "missed_call", phone: CALLER });
    expect(parseVoiceEmail(voicemailEmail("Hi this is Dana, my laptop is overheating, call me back"), GV)).toEqual({
      kind: "voicemail", phone: CALLER, transcript: "Hi this is Dana, my laptop is overheating, call me back",
    });
    expect(parseVoiceEmail(voicemailEmail("Transcript not available"), GV)).toMatchObject({ kind: "voicemail", transcript: "" });
  });
  it("returns unknown instead of guessing", () => {
    expect(parseVoiceEmail({ from: "Google Voice <voice-noreply@google.com>", subject: "New group message", text: "hi" }, GV).kind).toBe("unknown");
    expect(parseVoiceEmail({ from: "Google Voice <voice-noreply@google.com>", subject: "Your Google Voice number", text: "..." }, GV).kind).toBe("unknown");
    expect(parseVoiceEmail({ ...missedEmail("Unknown caller"), text: "Missed call" }, GV).kind).toBe("unknown");
  });
  it("handles HTML-only bodies", () => {
    expect(htmlToText("<div>Hello&nbsp;there</div><br><p>Line 2</p>")).toBe("Hello there\n\nLine 2");
  });
});

describe("co-pilot flows", () => {
  it("missed call -> the owner gets a draft opener with one-tap links; nothing is sent automatically", async () => {
    const ctx = await gvCtx();
    ctx.gmail.deliver({ ...missedEmail(), date: ctx.now.t });
    expect(await pollGoogleVoice(ctx.deps)).toBe(1);

    expect(ctx.tel.sent).toEqual([]); // the rule that matters
    expect(drafts(ctx)).toHaveLength(1);
    const d = drafts(ctx)[0];
    expect(d.to).toBe(OWNER_EMAIL);
    expect(d.subject).toContain("(706) 555-1234");
    expect(d.text).toContain("Hey, this is Jesse's line at JustTech — sorry we missed your call.");
    expect(d.text).toContain("Open Google Voice: https://voice.google.com/u/0/messages");
    expect(d.text).toContain("I sent it: https://ff.test/a/");
    expect(alerts(ctx)).toHaveLength(0); // the draft is the alert — no duplicate email
    const { rows } = await ctx.deps.db.query("SELECT status FROM messages WHERE kind = 'opener'");
    expect(rows[0].status).toBe("drafted");
  });

  it("customer texts are answered with AI drafts written in the owner's voice", async () => {
    const ctx = await gvCtx();
    ctx.gmail.deliver({ ...missedEmail(), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    ctx.ai.push(tb({ reply: "Sorry to hear that — who am I texting with?", need: "printer won't connect" }));
    ctx.gmail.deliver({ ...textEmail("my printer won't connect"), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    expect(drafts(ctx).at(-1)!.text).toContain("Sorry to hear that — who am I texting with?");
    expect(ctx.ai.calls[0].system).toContain("Jesse reviews each draft and sends it personally");

    // Capture: the owner takes over. No "I've passed this to Jesse" draft for Jesse to send himself.
    ctx.ai.push(tb({ name: "Lee", need: "printer won't connect" }));
    ctx.gmail.deliver({ ...textEmail("I'm Lee"), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    expect(drafts(ctx)).toHaveLength(2);
    expect(alerts(ctx).at(-1)!.text).toContain("New lead (text-back): Lee · (706) 555-1234 · printer won't connect");
    expect(alerts(ctx).at(-1)!.text).toContain("Pause this lead");
    expect((await leadByPhone(ctx)).status).toBe("human");
    expect(ctx.tel.sent).toEqual([]);
  });

  it("a voicemail with a transcript gets a reply that answers what they said", async () => {
    const ctx = await gvCtx();
    ctx.ai.push(tb({ reply: "Is it a laptop or a desktop?", need: "computer overheating" }));
    ctx.gmail.deliver({ ...voicemailEmail("Hey my computer keeps overheating and shutting off, call me back"), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    expect(drafts(ctx)[0].text).toContain("Hey, this is Jesse at JustTech — got your voicemail. Is it a laptop or a desktop?");
    const turns = ctx.ai.calls[0].messages.map((m) => m.content).join("\n");
    expect(turns).toContain("keeps overheating");
    expect((await leadByPhone(ctx)).need).toBe("computer overheating");
  });

  it("a voicemail with no transcript is treated as a missed call", async () => {
    const ctx = await gvCtx();
    ctx.gmail.deliver({ ...voicemailEmail("Transcript not available"), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    expect(drafts(ctx)[0].text).toContain("sorry we missed your call");
  });

  it("an email it can't read alerts the owner (fail loud) and isn't retried forever", async () => {
    const ctx = await gvCtx();
    ctx.gmail.deliver({ from: "Google Voice <voice-noreply@google.com>", subject: "New group message", text: "hi all", date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    expect(alerts(ctx)[0].text).toContain("couldn't read a Google Voice email");
    expect(await ctx.gmail.listUnprocessed()).toEqual([]);
  });

  it("ignores the backlog from before it was switched on", async () => {
    const ctx = await makeCtx({ env: GV_ENV, at: et("2026-10-20 10:00") });
    ctx.gmail.deliver({ ...missedEmail(), date: et("2026-10-19 15:00") });
    await pollGoogleVoice(ctx.deps);
    expect(ctx.gmail.sent).toEqual([]);
    expect(await ctx.gmail.listUnprocessed()).toEqual([]);
  });

  it("an email processed twice (label failed to stick) drafts only once", async () => {
    const ctx = await gvCtx();
    const id = ctx.gmail.deliver({ ...missedEmail(), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    ctx.gmail.inbox.find((m) => m.id === id)!.processed = false;
    await pollGoogleVoice(ctx.deps);
    expect(drafts(ctx)).toHaveLength(1);
  });

  it("a processing error leaves the email for the next poll and alerts once", async () => {
    const ctx = await gvCtx();
    ctx.gmail.deliver({ ...missedEmail(), date: ctx.now.t });
    const realSend = ctx.gmail.send.bind(ctx.gmail);
    let fail = 2;
    ctx.gmail.send = async (to, subject, text) => {
      if (subject.startsWith("Text ") && fail-- > 0) throw new Error("gmail 503");
      return realSend(to, subject, text);
    };
    await pollGoogleVoice(ctx.deps); // draft fails -> email left for retry, owner alerted
    await pollGoogleVoice(ctx.deps); // fails again -> no second alert
    expect(alerts(ctx).filter((a) => a.text.includes("System error handling a Google Voice email"))).toHaveLength(1);
    expect(await ctx.gmail.listUnprocessed()).toHaveLength(1);
    await pollGoogleVoice(ctx.deps); // Gmail is back: the draft goes out exactly once
    expect(drafts(ctx)).toHaveLength(1);
    expect(await ctx.gmail.listUnprocessed()).toEqual([]);
    expect(await events(ctx, "error")).not.toHaveLength(0);
  });

  it("STOP by text opts them out of every future draft", async () => {
    const ctx = await gvCtx();
    ctx.gmail.deliver({ ...missedEmail(), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    ctx.gmail.deliver({ ...textEmail("STOP"), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    expect((await leadByPhone(ctx)).opted_out_at).not.toBeNull();
    ctx.advance(60 * 30);
    await ctx.runJobs();
    expect(drafts(ctx)).toHaveLength(1);
  });
});

describe("one-tap links", () => {
  it("'I sent it' needs a confirm tap (link scanners can't trigger it), then marks the text sent", async () => {
    const ctx = await gvCtx();
    ctx.gmail.deliver({ ...missedEmail(), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    const path = linkFrom(drafts(ctx)[0].text, "I sent it");
    const get = await request(ctx.app).get(path);
    expect(get.text).toContain("<form method=\"post\">");
    let { rows } = await ctx.deps.db.query("SELECT status FROM messages WHERE kind = 'opener'");
    expect(rows[0].status).toBe("drafted");
    await request(ctx.app).post(path);
    ({ rows } = await ctx.deps.db.query("SELECT status FROM messages WHERE kind = 'opener'"));
    expect(rows[0].status).toBe("sent");
  });

  it("'Pause' hands the lead to the owner and stops its follow-ups", async () => {
    const ctx = await gvCtx();
    ctx.gmail.deliver({ ...missedEmail(), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    await request(ctx.app).post(linkFrom(drafts(ctx)[0].text, "Pause this lead \\(I'll handle it myself\\)"));
    expect((await leadByPhone(ctx)).status).toBe("human");
    ctx.advance(60 * 24 * 8);
    await ctx.runJobs();
    expect(drafts(ctx)).toHaveLength(1);
  });

  it("rejects tampered or expired links", async () => {
    const ctx = await gvCtx();
    ctx.gmail.deliver({ ...missedEmail(), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    const path = linkFrom(drafts(ctx)[0].text, "I sent it");
    expect((await request(ctx.app).post(path.slice(0, -2) + "xx")).status).toBe(404);
    ctx.advance(60 * 24 * 15);
    expect((await request(ctx.app).post(path)).status).toBe(404);
  });
});

describe("follow-up and summary in co-pilot mode", () => {
  it("follow-ups arrive as drafts at the scheduled times, still never in quiet hours", async () => {
    const ctx = await gvCtx(et("2026-10-20 19:00"));
    ctx.gmail.deliver({ ...missedEmail(), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    for (let i = 0; i < 9 * 24 * 6; i++) {
      ctx.advance(10);
      await ctx.runJobs();
    }
    const followups = drafts(ctx).slice(1);
    expect(followups).toHaveLength(4);
    expect(followups[0].text).toContain("Follow-up 1 of 4");
    expect(followups[3].text).toContain("just reply here and I'll take care of you"); // first-person variant
    expect(ctx.tel.sent).toEqual([]);
    const { rows } = await ctx.deps.db.query("SELECT at FROM messages WHERE kind LIKE 'followup%'");
    for (const r of rows) {
      const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }).format(new Date(r.at)));
      expect(h >= 8 && h < 20).toBe(true);
    }
  });

  it("the daily summary is one email with the full detail", async () => {
    const ctx = await gvCtx();
    ctx.gmail.deliver({ ...missedEmail(), date: ctx.now.t });
    await pollGoogleVoice(ctx.deps);
    await sendDailySummary(ctx.deps);
    const s = alerts(ctx).filter((a) => a.subject.includes("daily summary"));
    expect(s).toHaveLength(1);
    expect(s[0].text).toContain("New leads (last 24h)");
    expect(s[0].text).toContain("(706) 555-1234");
    expect(ctx.mailer.sent).toEqual([]);
  });
});
