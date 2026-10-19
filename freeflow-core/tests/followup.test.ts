// System 3 — lead follow-up acceptance tests (Section 6), with accelerated timings.
import { DateTime } from "luxon";
import { beforeEach, describe, expect, it } from "vitest";
import { recoverStaleJobs, runDueJobs } from "../src/core/jobs.js";
import { updateLead } from "../src/core/store.js";
import { resetLead } from "../src/flows/controls.js";
import { jobHandlers } from "../src/flows/handlers.js";
import { handleMissedCall } from "../src/flows/textback.js";
import { CALLER, et, events, jobs, leadByPhone, makeCtx, resetDb, textIn, type TestCtx } from "./helpers.js";

beforeEach(resetDb);

const ACCEL = { FOLLOWUP_ACCELERATED: "true" };

/** Step the clock in small increments, running due jobs each tick (like the poller). */
async function runFor(ctx: TestCtx, minutes: number, tickSeconds = 30) {
  const end = ctx.now.t.getTime() + minutes * 60_000;
  while (ctx.now.t.getTime() < end) {
    ctx.now.t = new Date(ctx.now.t.getTime() + tickSeconds * 1000);
    await ctx.runJobs();
  }
}

function sentAt(ctx: TestCtx) {
  return ctx.deps.db.query("SELECT kind, at FROM messages WHERE direction = 'outbound' AND kind LIKE 'followup%' ORDER BY at").then((r) => r.rows);
}

async function quietLead(ctx: TestCtx) {
  await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA1" });
  await updateLead(ctx.deps.db, (await leadByPhone(ctx)).id, { name: "Ana", need: "a cracked laptop screen" });
}

describe("follow-up sequence", () => {
  it("an unanswered lead gets steps 1-4 at the configured (accelerated) times, then silence", async () => {
    const ctx = await makeCtx({ env: ACCEL, at: et("2026-10-20 09:00") });
    const t0 = ctx.now.t.getTime();
    await quietLead(ctx);
    await runFor(ctx, 300); // 5 hours of accelerated time >> 168 min

    const sends = await sentAt(ctx);
    expect(sends.map((s) => s.kind)).toEqual(["followup_step_1", "followup_step_2", "followup_step_3", "followup_step_4"]);
    // Accelerated offsets: 120 / 1440 / 4320 / 10080 minutes run as seconds -> 2 / 24 / 72 / 168 min.
    const mins = sends.map((s) => Math.round((new Date(s.at).getTime() - t0) / 60_000));
    expect(mins).toEqual([2, 24, 72, 168]);

    const texts = ctx.leadTexts();
    expect(texts[1]).toBe("Hi Ana, it's JustTech — still want help with a cracked laptop screen? Happy to get you a time.");
    expect(texts[3]).toContain("book you in this week, or close this out");
    expect(texts[4]).toContain("last note from JustTech");
    expect((await leadByPhone(ctx)).status).toBe("closed");
    expect(await jobs(ctx, "pending")).toHaveLength(0);
    await runFor(ctx, 600);
    expect(ctx.leadTexts()).toHaveLength(5); // silence after step 4
  });

  it("uses real offsets in production mode (step 1 at +2 hours)", async () => {
    const ctx = await makeCtx({ at: et("2026-10-20 09:00") });
    await quietLead(ctx);
    const [job] = await jobs(ctx, "pending");
    expect(new Date(job.run_at).toISOString()).toBe(et("2026-10-20 11:00").toISOString());
  });

  it("a reply at any step cancels every pending job and alerts Jesse", async () => {
    const ctx = await makeCtx({ env: ACCEL, at: et("2026-10-20 09:00") });
    await quietLead(ctx);
    await runFor(ctx, 30); // steps 1 and 2 sent
    expect((await sentAt(ctx)).length).toBe(2);
    await textIn(ctx, "yes please, can he come Thursday?");
    expect(await jobs(ctx, "pending")).toHaveLength(0);
    expect((await leadByPhone(ctx)).status).toBe("human");
    expect(ctx.ownerTexts().at(-1)).toContain("replied to follow-up");
    expect(ctx.ownerTexts().at(-1)).toContain("can he come Thursday?");
    await runFor(ctx, 300);
    expect((await sentAt(ctx)).length).toBe(2);
  });

  it("the reply check runs before every send, not just at scheduling time", async () => {
    const ctx = await makeCtx({ env: ACCEL, at: et("2026-10-20 09:00") });
    await quietLead(ctx);
    const lead = await leadByPhone(ctx);
    // A reply recorded without going through the inbound handler (no cancel ran).
    await ctx.deps.db.query("INSERT INTO messages (lead_id, direction, channel, body, at) VALUES ($1,'inbound','sms','hi',$2)", [lead.id, new Date(ctx.now.t.getTime() + 1000)]);
    await runFor(ctx, 10);
    expect(await sentAt(ctx)).toHaveLength(0);
    expect((await jobs(ctx, "cancelled")).at(-1).last_error).toBe("lead replied");
  });

  it("never sends outside 8:00 AM - 8:00 PM Eastern (quiet hours simulated)", async () => {
    const ctx = await makeCtx({ at: et("2026-10-20 19:00") });
    await quietLead(ctx); // step 1 due 21:00 -> waits for 8:00
    // Run 9 real days in 10-minute ticks.
    await runFor(ctx, 9 * 24 * 60, 600);
    const sends = await sentAt(ctx);
    expect(sends).toHaveLength(4);
    for (const s of sends) {
      const h = DateTime.fromJSDate(new Date(s.at), { zone: "America/New_York" }).hour;
      expect(h >= 8 && h < 20, `sent at ${h}:00`).toBe(true);
    }
    expect(new Date(sends[0].at).getTime()).toBeLessThanOrEqual(et("2026-10-21 08:10").getTime());
    expect(new Date(sends[0].at).getTime()).toBeGreaterThanOrEqual(et("2026-10-21 08:00").getTime());
  });

  it("human-owned or booked leads receive no follow-up sends", async () => {
    for (const status of ["human", "booked"] as const) {
      await resetDb();
      const ctx = await makeCtx({ env: ACCEL });
      await quietLead(ctx);
      await updateLead(ctx.deps.db, (await leadByPhone(ctx)).id, { status });
      await runFor(ctx, 300);
      expect(await sentAt(ctx), status).toHaveLength(0);
    }
  });

  it("restarting mid-sequence causes no duplicate or lost sends", async () => {
    const ctx = await makeCtx({ env: ACCEL, at: et("2026-10-20 09:00") });
    await quietLead(ctx);
    await runFor(ctx, 3); // step 1 sent
    const lead = await leadByPhone(ctx);

    // Crash #1: step 2 claimed ('running') and the process died before sending.
    ctx.now.t = new Date(ctx.now.t.getTime() + 25 * 60_000);
    await ctx.deps.db.query("UPDATE jobs SET status='running', locked_at=$1 WHERE status='pending' AND step_no=2", [ctx.now.t]);
    ctx.advance(10);
    expect(await recoverStaleJobs(ctx.deps)).toBe(1);
    await ctx.runJobs();
    expect((await sentAt(ctx)).map((s) => s.kind)).toEqual(["followup_step_1", "followup_step_2"]);

    // Crash #2: step 3 sent by the provider, process died before marking the job done.
    await runFor(ctx, 50);
    expect((await sentAt(ctx)).map((s) => s.kind)).toContain("followup_step_3");
    const [{ id: j3 }] = (await jobs(ctx)).filter((j) => j.step_no === 3);
    await ctx.deps.db.query("UPDATE jobs SET status='running', locked_at=$2 WHERE id=$1", [j3, new Date(ctx.now.t.getTime() - 10 * 60_000)]);
    // ...and before it scheduled step 4.
    await ctx.deps.db.query("DELETE FROM jobs WHERE lead_id=$1 AND step_no=4", [lead.id]);
    await recoverStaleJobs(ctx.deps);
    await ctx.runJobs(); // re-runs step 3: message key already exists -> no second send, sequence continues
    await runFor(ctx, 200);
    const kinds = (await sentAt(ctx)).map((s) => s.kind);
    expect(kinds).toEqual(["followup_step_1", "followup_step_2", "followup_step_3", "followup_step_4"]);
    expect(ctx.leadTexts().filter((t) => t.includes("book you in this week"))).toHaveLength(1);
  });

  it("two pollers running at once never double-send", async () => {
    const ctx = await makeCtx({ env: ACCEL });
    for (let i = 0; i < 5; i++) await handleMissedCall(ctx.deps, { from: `+1706555200${i}`, callSid: `CA${i}` });
    ctx.advance(3);
    await Promise.all([runDueJobs(ctx.deps, jobHandlers), runDueJobs(ctx.deps, jobHandlers), runDueJobs(ctx.deps, jobHandlers)]);
    expect((await sentAt(ctx)).length).toBe(5);
  });

  it("one sequence per lead: a returning lead doesn't restart it; Jesse's reset does", async () => {
    const ctx = await makeCtx({ env: ACCEL, at: et("2026-10-20 09:00") });
    await quietLead(ctx);
    await runFor(ctx, 200);
    expect((await leadByPhone(ctx)).status).toBe("closed");
    ctx.advance(60 * 24); // next day, daytime, past the 24h dedupe window
    await handleMissedCall(ctx.deps, { from: CALLER, callSid: "CA9" }); // returns via a new missed call
    await runFor(ctx, 200);
    expect((await sentAt(ctx)).length).toBe(4); // no second sequence
    await resetLead(ctx.deps, await leadByPhone(ctx), "test");
    await runFor(ctx, 5);
    expect((await sentAt(ctx)).length).toBe(5);
    expect(await events(ctx, "reset")).toHaveLength(1);
  });
});

describe("Checkpoint D audit", () => {
  it("is clean after a full sequence, a reply hand-off and a STOP", async () => {
    const { audit } = await import("../src/flows/audit.js");
    const ctx = await makeCtx({ env: ACCEL, at: et("2026-10-20 09:00") });
    await quietLead(ctx);
    await runFor(ctx, 30);
    await textIn(ctx, "yes please");
    await handleMissedCall(ctx.deps, { from: "+17065558888", callSid: "CA8" });
    await textIn(ctx, "STOP", "+17065558888");
    await runFor(ctx, 300);
    const r = await audit(ctx.deps);
    expect(r).toMatchObject({ duplicate_sends: [], sends_after_stop: [], followups_after_reply: [], automated_sends_to_owned_leads: [] });
    expect(r.conversations).toBe(2);
  });
});
