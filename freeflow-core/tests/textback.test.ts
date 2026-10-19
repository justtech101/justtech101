// System 1 — missed-call text-back acceptance tests (Section 6).
import { beforeEach, describe, expect, it } from "vitest";
import { handleMissedCall } from "../src/flows/textback.js";
import { CALLER, et, events, jobs, leadByPhone, makeCtx, nextSid, OWNER, resetDb, tb, textIn, turn, type TestCtx } from "./helpers.js";

beforeEach(resetDb);

const OPENER = "Hey, this is Jesse's line at JustTech — sorry we missed your call. What can we help with? Reply here and we'll get you sorted.";

/** Full Twilio path: ring the owner, no answer, receptionist greets, caller hangs up, status callback. */
async function missedCallViaWebhooks(ctx: TestCtx, from = CALLER) {
  const CallSid = nextSid("CA");
  const incoming = await ctx.post("/voice/incoming", { CallSid, From: from });
  expect(incoming.text).toContain("<Dial");
  const dial = await ctx.post("/voice/dial-complete", { CallSid, DialCallStatus: "no-answer" });
  expect(dial.text).toContain("<Gather"); // receptionist picks up — caller never hears silence
  const started = Date.now();
  await ctx.post("/voice/status", { CallSid, CallStatus: "completed" });
  return Date.now() - started;
}

describe("missed call -> text-back", () => {
  it("texts the opener immediately, three calls in a row from different phones, each with an alert", async () => {
    const ctx = await makeCtx({ env: { OWNER_FORWARD_NUMBER: "+17065559999" } });
    const phones = ["+17065551111", "+17065552222", "+17065553333"];
    for (const p of phones) {
      const ms = await missedCallViaWebhooks(ctx, p);
      expect(ms).toBeLessThan(60_000);
      expect(ctx.leadTexts(p)).toEqual([OPENER]);
      const lead = await leadByPhone(ctx, p);
      expect(lead).toMatchObject({ source: "call", flow: "textback" });
    }
    expect(ctx.ownerTexts()).toHaveLength(3);
    expect(ctx.ownerTexts()[0]).toContain("(706) 555-1111");
  });

  it("works when the receptionist is disabled (ring owner, then text)", async () => {
    const ctx = await makeCtx({ env: { OWNER_FORWARD_NUMBER: "+17065559999" }, config: (c) => { c.voice.receptionist_enabled = false; } });
    const CallSid = nextSid("CA");
    await ctx.post("/voice/incoming", { CallSid, From: CALLER });
    const dial = await ctx.post("/voice/dial-complete", { CallSid, DialCallStatus: "busy" });
    expect(dial.text).toContain("We'll text you right away");
    await ctx.post("/voice/status", { CallSid, CallStatus: "completed" });
    expect(ctx.leadTexts()).toEqual([OPENER]);
  });

  it("does not text when the owner answered", async () => {
    const ctx = await makeCtx({ env: { OWNER_FORWARD_NUMBER: "+17065559999" } });
    const CallSid = nextSid("CA");
    await ctx.post("/voice/incoming", { CallSid, From: CALLER });
    await ctx.post("/voice/dial-complete", { CallSid, DialCallStatus: "completed" });
    await ctx.post("/voice/status", { CallSid, CallStatus: "completed" });
    expect(ctx.leadTexts()).toEqual([]);
  });

  it("sends no duplicate opener for a second missed call within 24 hours", async () => {
    const ctx = await makeCtx();
    expect(await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" })).toBe("texted");
    ctx.advance(60 * 5);
    expect(await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA2" })).toBe("duplicate");
    expect(ctx.leadTexts()).toHaveLength(1);
    expect(await events(ctx, "repeat_missed_call")).toHaveLength(1);
    ctx.advance(60 * 24);
    expect(await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA3" })).toBe("texted");
  });

  it("adds the reopening time after hours (hours from config)", async () => {
    const ctx = await makeCtx({
      at: et("2026-10-20 19:30"),
      config: (c) => { c.hours = { mon: ["09:00", "17:00"], tue: ["09:00", "17:00"], wed: ["09:00", "17:00"] }; },
    });
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    expect(ctx.leadTexts()[0]).toContain("We're back at 9 AM tomorrow");
  });
});

describe("text-back conversation", () => {
  it("captures name and need as structured fields and alerts Jesse within the minute", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    ctx.ai.push(tb({ reply: "Sorry to hear that! Who am I texting with?", need: "laptop won't turn on" }));
    await textIn(ctx, "my laptop won't turn on");
    ctx.ai.push(tb({ name: "Maria", need: "laptop won't turn on" }));
    ctx.advance(0.5);
    await textIn(ctx, "Maria");

    const lead = await leadByPhone(ctx);
    expect(lead).toMatchObject({ name: "Maria", need: "laptop won't turn on", status: "human", flow: null });
    const alert = ctx.ownerTexts().at(-1)!;
    expect(alert).toContain("Maria");
    expect(alert).toContain("(706) 555-1234");
    expect(alert).toContain("laptop won't turn on");
    expect(ctx.leadTexts().at(-1)).toContain("Thanks, Maria");
    expect(await jobs(ctx, "pending")).toHaveLength(0); // automation stops talking over him
  });

  it("STOP ends the thread permanently, in every system, and is logged", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    await textIn(ctx, "STOP");
    const lead = await leadByPhone(ctx);
    expect(lead.opted_out_at).not.toBeNull();
    expect(await events(ctx, "stop")).toHaveLength(1);
    expect(await jobs(ctx, "pending")).toHaveLength(0);

    ctx.advance(60 * 48);
    expect(await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA2" })).toBe("opted_out");
    await textIn(ctx, "hello?");
    await ctx.runJobs();
    expect(ctx.leadTexts()).toEqual([OPENER]); // never messaged again
  });

  it("landline / non-SMS number: logs it and alerts Jesse as a plain missed call", async () => {
    const ctx = await makeCtx();
    ctx.tel.failNumbers.add(CALLER);
    expect(await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" })).toBe("send_failed");
    expect(ctx.ownerTexts()[0]).toContain("couldn't text back");
    const { rows } = await ctx.deps.db.query("SELECT status, error FROM messages WHERE kind = 'opener'");
    expect(rows[0].status).toBe("failed");
  });

  it("alerts when the opener is later reported undelivered (async landline failure)", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    const sid = ctx.tel.to(CALLER)[0].sid;
    await ctx.post("/webhooks/sms-status", { MessageSid: sid, MessageStatus: "undelivered", ErrorCode: "30006" });
    expect(ctx.ownerTexts().at(-1)).toContain("didn't deliver");
  });

  it("spam / one-word replies: two polite attempts, then closes quietly", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    const alertsBefore = ctx.ownerTexts().length;
    ctx.ai.push(tb({ reply: "No problem — what can we help with?", low_signal: true }), tb({ reply: "Just let me know what you need!", low_signal: true }), tb({ low_signal: true }));
    await textIn(ctx, "k");
    await textIn(ctx, "?");
    await textIn(ctx, "k");
    expect(ctx.leadTexts()).toHaveLength(3); // opener + 2 attempts
    expect((await leadByPhone(ctx)).status).toBe("closed");
    expect(ctx.ownerTexts().length).toBe(alertsBefore); // quietly
  });

  it("hands off after 4 exchanges without progress", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    for (let i = 0; i < 4; i++) ctx.ai.push(tb({ reply: "Tell me more?" }));
    for (let i = 0; i < 4; i++) await textIn(ctx, `message ${i}`);
    expect((await leadByPhone(ctx)).status).toBe("human");
    expect(ctx.ownerTexts().at(-1)).toContain("stalled after 4 exchanges");
  });

  it("HUMAN from the customer hands off immediately", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    await textIn(ctx, "human");
    expect((await leadByPhone(ctx)).status).toBe("human");
    expect(ctx.ownerTexts().at(-1)).toContain("asked for a human");
    expect(ctx.ai.calls).toHaveLength(0);
  });

  it("AI error fails loud: fallback text to the customer, alert to Jesse", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    ctx.ai.push(new Error("overloaded"));
    await textIn(ctx, "my phone screen is cracked");
    expect(ctx.leadTexts().at(-1)).toContain("will get back to you personally");
    expect(ctx.ownerTexts().at(-1)).toContain("AI error");
    expect((await events(ctx, "error")).length).toBeGreaterThan(0);
  });

  it("never sends an invented price even if the model writes one", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    ctx.ai.push(tb({ reply: "Screen repairs are usually $89!" }));
    await textIn(ctx, "how much for a screen?");
    expect(ctx.leadTexts().at(-1)).toBe("Let me have Jesse confirm that and get right back to you.");
    expect(await events(ctx, "guardrail")).toHaveLength(1);
  });

  it("caller rings again mid-thread: voice takes over and the SMS thread notes it", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    const res = await ctx.post("/voice/incoming", { CallSid: nextSid("CA"), From: CALLER });
    expect(res.text).toContain("<Gather");
    const { rows } = await ctx.deps.db.query("SELECT body FROM messages WHERE direction = 'note'");
    expect(rows[0].body).toContain("now on a call");
    expect((await leadByPhone(ctx)).flow).toBeNull();
  });
});

describe("Jesse can always break in", () => {
  it("any text from Jesse's number pauses automation on the latest alerted thread", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    expect(await jobs(ctx, "pending")).toHaveLength(1); // follow-up armed
    await textIn(ctx, "got it, I'll call her", OWNER);
    const lead = await leadByPhone(ctx);
    expect(lead.status).toBe("human");
    expect(await jobs(ctx, "pending")).toHaveLength(0);
    expect(ctx.ownerTexts().at(-1)).toContain("Paused");
  });

  it("SAY relays a message to the lead as Jesse and keeps automation off", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    await textIn(ctx, "SAY 706-555-1234 On my way in 10!", OWNER);
    expect(ctx.leadTexts().at(-1)).toBe("On my way in 10!");
    expect((await leadByPhone(ctx)).status).toBe("human");
  });

  it("PAUSE ALL holds every automated send until RESUME ALL", async () => {
    const ctx = await makeCtx();
    await textIn(ctx, "PAUSE ALL", OWNER);
    expect(await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" })).toBe("paused");
    expect(ctx.leadTexts()).toEqual([]);
    await textIn(ctx, "RESUME ALL", OWNER);
    ctx.advance(1);
    expect(await handleMissedCall(ctx.deps, { from: "+17065557777", callSid: "CA2" })).toBe("texted");
  });
});

describe("SMS webhook", () => {
  it("records the text before acknowledging, and processes quick double-texts in order", async () => {
    const ctx = await makeCtx();
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
    ctx.ai.push(tb({ reply: "Sorry to hear that! What's your name?", need: "tablet won't charge" }), tb({ name: "Kim", need: "tablet won't charge" }));
    const a = ctx.post("/sms/incoming", { From: CALLER, Body: "my tablet won't charge", MessageSid: nextSid() });
    const b = ctx.post("/sms/incoming", { From: CALLER, Body: "I'm Kim", MessageSid: nextSid() });
    expect((await a).text).toBe("<Response/>");
    await b;
    // Background processing: wait until the second reply has gone out.
    for (let i = 0; i < 50 && ctx.leadTexts().length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    expect(ctx.leadTexts().at(-1)).toContain("Thanks, Kim");
    expect((await leadByPhone(ctx)).status).toBe("human");
  });

  it("ignores a duplicate delivery of the same MessageSid", async () => {
    const ctx = await makeCtx();
    const MessageSid = nextSid();
    ctx.ai.push(turn("answer", { need: "email setup" }));
    await ctx.post("/sms/incoming", { From: CALLER, Body: "need help setting up email", MessageSid });
    await ctx.post("/sms/incoming", { From: CALLER, Body: "need help setting up email", MessageSid });
    for (let i = 0; i < 50 && ctx.leadTexts().length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    const { rows } = await ctx.deps.db.query("SELECT count(*)::int AS n FROM messages WHERE direction = 'inbound'");
    expect(rows[0].n).toBe(1);
    expect(ctx.leadTexts()).toHaveLength(1);
  });
});
