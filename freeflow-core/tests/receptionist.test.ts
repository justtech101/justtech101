// System 2 — AI receptionist / intake acceptance tests (Section 6).
import { beforeEach, describe, expect, it } from "vitest";
import { ensureDailySummaryJob } from "../src/flows/summary.js";
import { CALLER, et, events, jobs, leadByPhone, makeCtx, nextSid, resetDb, textIn, turn, type TestCtx } from "./helpers.js";

beforeEach(resetDb);

const windows = (c: any) => { c.callback_windows = [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "17:00", end: "18:00" }]; };

async function startCall(ctx: TestCtx) {
  const CallSid = nextSid("CA");
  const res = await ctx.post("/voice/incoming", { CallSid, From: CALLER });
  const say = (speech: string) => ctx.post("/voice/gather", { CallSid, SpeechResult: speech }).then((r) => r.text);
  return { CallSid, first: res.text, say };
}

describe("voice intake", () => {
  it("completes all six questions, reads the number back, books the callback with both alerts, and shows in the next daily summary", async () => {
    const ctx = await makeCtx({ at: et("2026-10-20 18:30"), config: windows });
    const call = await startCall(ctx);
    expect(call.first).toContain("automated assistant");
    expect(call.first).toContain("What do you need help with?");

    ctx.ai.push(
      turn("answer", { need: "laptop won't turn on" }, { ack: "Sorry to hear that." }),
      turn("answer", { details: "Dell laptop, black screen after an update" }),
      turn("answer", { location: "Martinez", in_service_area: true }),
      turn("answer", { urgency: "this week" }),
      turn("answer", { name: "Maria" }),
      turn("answer", { confirm: true }),
      turn("answer", { confirm: true }),
    );
    expect(await call.say("my laptop won't turn on")).toContain("What's the device or service");
    expect(await call.say("a Dell, black screen after an update")).toContain("Where are you located?");
    expect(await call.say("Martinez")).toContain("How urgent is it");
    expect(await call.say("sometime this week")).toContain("what's your name?");
    const readBack = await call.say("Maria");
    expect(readBack).toContain("7 0 6, 5 5 5, 1 2 3 4"); // number read back digit by digit
    expect(await call.say("yes")).toContain("Jesse can call you back tomorrow between 5 PM and 6 PM — does that work?");
    const close = await call.say("yes that works");
    expect(close).toContain("You're all set, Maria");
    expect(close).toContain("<Hangup/>");

    const lead = await leadByPhone(ctx);
    expect(lead).toMatchObject({ name: "Maria", need: "laptop won't turn on", location: "Martinez", urgency: "this week", callback_number: CALLER, status: "booked" });

    // Alert 1: at booking time, with the full summary.
    const booked = ctx.ownerTexts().find((t) => t.startsWith("BOOKED"))!;
    for (const part of ["Maria", "(706) 555-1234", "laptop won't turn on", "this week", "Martinez", "Next:"]) expect(booked).toContain(part);

    // Full transcript is in messages.
    const { rows } = await ctx.deps.db.query("SELECT count(*)::int AS n FROM messages WHERE channel = 'voice-transcript'");
    expect(rows[0].n).toBe(15);

    // Next daily summary (Wed 8:00) lists the callback.
    await ensureDailySummaryJob(ctx.deps);
    ctx.now.t = et("2026-10-21 08:00");
    await ctx.runJobs();
    expect(ctx.ownerTexts().at(-1)).toContain("Callbacks today: 1 — Maria");

    // Alert 2: 15 minutes before the window.
    ctx.now.t = et("2026-10-21 16:45");
    await ctx.runJobs();
    expect(ctx.ownerTexts().at(-1)).toMatch(/^REMINDER: callback Maria/);
  });

  it("reads back a different number the caller gives before accepting it", async () => {
    const ctx = await makeCtx();
    const call = await startCall(ctx);
    ctx.ai.push(
      turn("answer", { need: "wifi down", details: "router keeps dropping", location: "Evans", urgency: "today", name: "Sam" }),
      turn("answer", { callback_number: "706-555-9876", confirm: false }),
      turn("answer", { confirm: true }),
    );
    expect(await call.say("wifi's down, router keeps dropping, I'm in Evans, need it today, I'm Sam")).toContain("7 0 6, 5 5 5, 1 2 3 4");
    expect(await call.say("no, call 706 555 9876")).toContain("I have 7 0 6, 5 5 5, 9 8 7 6. Is that right?");
    expect(await call.say("yes")).toContain("as soon as possible — does that work?"); // no windows configured
    expect((await ctx.deps.db.query("SELECT state FROM calls")).rows[0].state.fields.callback_number).toBe("+17065559876");
  });

  it("CHECKPOINT C: a price not in config is deferred to Jesse — nothing invented", async () => {
    const ctx = await makeCtx();
    const call = await startCall(ctx);
    ctx.ai.push(
      turn("question", { need: "cracked phone screen" }, { answer_to_question: "Let me have Jesse confirm that and get right back to you." }),
      // Even if the model slips and quotes a price, the guard replaces it.
      turn("question", {}, { answer_to_question: "Screens are usually $129 and take 2 hours." }),
    );
    const r1 = await call.say("how much do you charge to fix a cracked screen?");
    expect(r1).toContain("Let me have Jesse confirm that and get right back to you.");
    expect(r1).toContain("What's the device or service");
    const r2 = await call.say("come on, just ballpark it");
    expect(r2).not.toContain("$");
    expect(r2).not.toContain("129");
    expect(r2).toContain("Let me have Jesse confirm that");
    expect(await events(ctx, "guardrail")).toHaveLength(1);
  });

  it("asked for a human twice: hands off and alerts Jesse immediately", async () => {
    const ctx = await makeCtx();
    const call = await startCall(ctx);
    ctx.ai.push(turn("human_request"), turn("human_request"));
    expect(await call.say("can I talk to a real person")).toContain("I can definitely have Jesse call you");
    const r = await call.say("I said I want a human");
    expect(r).toContain("<Hangup/>");
    expect(ctx.ownerTexts().at(-1)).toMatch(/^HANDOFF/);
    expect((await leadByPhone(ctx)).status).toBe("human");
    expect((await events(ctx, "guardrail")).map((e) => e.detail)).toEqual(["asked for a human 2x -> handoff"]);
  });

  it("an upset caller goes straight to the 'Jesse will call you' path", async () => {
    const ctx = await makeCtx();
    const call = await startCall(ctx);
    ctx.ai.push(turn("upset"));
    const r = await call.say("this is ridiculous, third time I've called!");
    expect(r).toContain("I'm letting Jesse know right now");
    expect(ctx.ownerTexts().at(-1)).toContain("caller upset");
  });

  it("three off-script turns hand off", async () => {
    const ctx = await makeCtx();
    const call = await startCall(ctx);
    ctx.ai.push(turn("off_script"), turn("off_script"), turn("off_script"));
    expect(await call.say("did you see the game")).toContain("Sorry, I didn't quite catch that.");
    await call.say("the weather is nice");
    expect(await call.say("blah")).toContain("<Hangup/>");
    expect(ctx.ownerTexts().at(-1)).toContain("off-script");
  });

  it("with the AI layer disabled, a caller reaches voicemail — never silence", async () => {
    const ctx = await makeCtx({ env: { AI_DISABLED: "true" } });
    const call = await startCall(ctx);
    expect(call.first).toContain("<Record");
    expect(call.first).toContain("leave your name, number");
    const vm = await ctx.post("/voice/voicemail", { CallSid: call.CallSid, RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingDuration: "12" });
    expect(vm.text).toContain("Goodbye");
    expect(ctx.ownerTexts().at(-1)).toContain("Voicemail from (706) 555-1234");
  });

  it("an AI error mid-call falls back to voicemail and alerts Jesse", async () => {
    const ctx = await makeCtx();
    const call = await startCall(ctx);
    ctx.ai.push(new Error("timeout"));
    const r = await call.say("my printer is broken");
    expect(r).toContain("<Record");
    expect(ctx.ownerTexts().at(-1)).toContain("voicemail fallback");
  });

  it("the Twilio fallback URL answers with voicemail without touching the AI or DB", async () => {
    const ctx = await makeCtx();
    const r = await ctx.post("/voice/fallback", {});
    expect(r.text).toContain("<Record");
  });

  it("silence twice ends the call politely and sends a summary", async () => {
    const ctx = await makeCtx();
    const call = await startCall(ctx);
    const r1 = await ctx.post("/voice/gather", { CallSid: call.CallSid });
    expect(r1.text).toContain("Sorry, I didn't quite catch that.");
    const r2 = await ctx.post("/voice/gather", { CallSid: call.CallSid });
    expect(r2.text).toContain("I'm having trouble hearing you");
    expect(ctx.ownerTexts().at(-1)).toContain("Intake summary");
  });

  it("hanging up mid-intake sends Jesse what we have (no text-back on top)", async () => {
    const ctx = await makeCtx();
    const call = await startCall(ctx);
    ctx.ai.push(turn("answer", { need: "virus on my PC" }));
    await call.say("I think I have a virus");
    await ctx.post("/voice/status", { CallSid: call.CallSid, CallStatus: "completed" });
    expect(ctx.ownerTexts().at(-1)).toContain("virus on my PC");
    expect(ctx.ownerTexts().at(-1)).toContain("hung up mid-intake");
    expect(ctx.leadTexts()).toEqual([]);
  });
});

describe("SMS intake (same script, second channel)", () => {
  it("a new texter runs the script and ends with a written summary when they decline the callback", async () => {
    const ctx = await makeCtx();
    ctx.ai.push(
      turn("answer", { need: "printer jammed" }),
      turn("answer", { details: "HP office printer, paper stuck" }),
      turn("answer", { location: "Downtown Augusta", in_service_area: true }),
      turn("answer", { urgency: "today" }),
      turn("answer", { name: "Lee" }),
      turn("answer", { confirm: true }),
      turn("answer", { confirm: false }),
    );
    await textIn(ctx, "Hi, my printer is jammed");
    expect(ctx.leadTexts()[0]).toBe("Hi, this is Jesse's automated assistant at JustTech. I'll grab a few quick details so Jesse can get back to you. What's the device or service, and what's happening with it?");
    for (const m of ["HP office printer", "Downtown Augusta", "today", "Lee", "yes", "no thanks"]) {
      ctx.advance(1);
      await textIn(ctx, m);
    }
    expect(ctx.leadTexts().at(-1)).toContain("I've passed everything along");
    const lead = await leadByPhone(ctx);
    expect(lead).toMatchObject({ name: "Lee", need: "printer jammed", urgency: "today", status: "human", source: "sms" });
    const summary = ctx.ownerTexts().at(-1)!;
    expect(summary).toContain("Intake summary (sms)");
    expect(summary).toContain("Next: Call Lee back ASAP — they said it's urgent today.");
    expect(await jobs(ctx, "pending")).toHaveLength(0);
  });

  it("a bare 'hi' doesn't count as off-script", async () => {
    const ctx = await makeCtx();
    ctx.ai.push(turn("off_script"));
    await textIn(ctx, "hi");
    expect(ctx.leadTexts()[0]).toContain("What do you need help with?");
    expect((await leadByPhone(ctx)).flow_state.off_script).toBe(0);
  });

  it("a stalled SMS intake sends Jesse an FYI summary and stays in follow-up", async () => {
    const ctx = await makeCtx();
    ctx.ai.push(turn("answer", { need: "slow computer" }));
    await textIn(ctx, "my computer is super slow");
    ctx.advance(31);
    await ctx.runJobs();
    expect(ctx.ownerTexts().at(-1)).toContain("went quiet");
    expect((await leadByPhone(ctx)).status).toBe("engaged");
    expect((await jobs(ctx, "pending")).map((j) => j.type)).toEqual(["followup_step"]);
  });
});
