// Block A smoke tests: schema, core wrappers, config rules, admin API, daily summary.
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { normalizeTurns } from "../src/core/ai.js";
import { guardReply } from "../src/core/guard.js";
import { scheduleJob } from "../src/core/jobs.js";
import { normalizePhone, spokenPhone } from "../src/core/phone.js";
import { isQuietHours, nextCallbackWindow, quietHoursEnd } from "../src/core/time.js";
import { ensureDailySummaryJob } from "../src/flows/summary.js";
import { migrate } from "../src/migrate.js";
import { db, et, jobs, makeCtx, resetDb } from "./helpers.js";

beforeEach(resetDb);

const auth = { Authorization: "Bearer test-admin-key" };

describe("schema", () => {
  it("rebuilds from scratch", async () => {
    const d = await db();
    expect(await migrate(d, { reset: true })).toEqual(["001_init.sql"]);
    expect(await migrate(d)).toEqual([]);
    const { rows } = await d.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
    expect(rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(["leads", "messages", "jobs", "events", "calls", "settings"]));
  });
});

describe("admin API (Checkpoint A)", () => {
  it("creates a lead from a manual API call, deduped on phone", async () => {
    const ctx = await makeCtx();
    const res = await request(ctx.app).post("/leads").set(auth).send({ phone: "706-555-4321", name: "Dana", need: "laptop won't boot", consent_source: "called the shop, asked for a quote" });
    expect(res.status).toBe(201);
    expect(res.body.lead).toMatchObject({ phone: "+17065554321", name: "Dana", source: "manual", status: "new" });
    const again = await request(ctx.app).post("/leads").set(auth).send({ phone: "+1 (706) 555-4321", consent_source: "web form" });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
  });

  it("refuses a lead with no consent source (never cold-contact)", async () => {
    const ctx = await makeCtx();
    const res = await request(ctx.app).post("/leads").set(auth).send({ phone: "7065554321" });
    expect(res.status).toBe(400);
    expect((await (await db()).query("SELECT count(*) FROM leads")).rows[0].count).toBe("0");
  });

  it("rejects requests without the admin key", async () => {
    const ctx = await makeCtx();
    expect((await request(ctx.app).get("/admin/queue")).status).toBe(401);
    expect((await request(ctx.app).get("/admin/queue").set({ Authorization: "Bearer wrong-key-xxxxx" })).status).toBe(401);
  });

  it("sends a test SMS through the service", async () => {
    const ctx = await makeCtx();
    const res = await request(ctx.app).post("/admin/test-sms").set(auth).send({ body: "hello" });
    expect(res.body.sent).toBe(true);
    expect(ctx.ownerTexts()).toEqual(["hello"]);
  });

  it("runs the daily summary on demand", async () => {
    const ctx = await makeCtx();
    await request(ctx.app).post("/leads").set(auth).send({ phone: "7065554321", name: "Dana", consent_source: "walk-in" });
    const res = await request(ctx.app).post("/admin/summary").set(auth);
    expect(res.body.summary.newLeads).toHaveLength(1);
    expect(ctx.ownerTexts()[0]).toContain("New leads: 1");
    expect(ctx.mailer.sent[0].text).toContain("Dana");
  });
});

describe("webhook security", () => {
  it("rejects unsigned Twilio webhooks when validation is on", async () => {
    const ctx = await makeCtx({ env: { TWILIO_VALIDATE_SIGNATURES: "true", TWILIO_AUTH_TOKEN: "secret" } });
    const res = await request(buildApp(ctx.deps)).post("/sms/incoming").type("form").send({ From: "+17065551234", Body: "hi" });
    expect(res.status).toBe(403);
  });
});

describe("daily summary scheduling", () => {
  it("keeps exactly one job at the next 8:00 AM Eastern", async () => {
    const ctx = await makeCtx({ at: et("2026-10-20 09:30") });
    await ensureDailySummaryJob(ctx.deps);
    await ensureDailySummaryJob(ctx.deps);
    const j = await jobs(ctx);
    expect(j).toHaveLength(1);
    expect(new Date(j[0].run_at).toISOString()).toBe(et("2026-10-21 08:00").toISOString());
  });
});

describe("guardrails", () => {
  it("blocks prices, discounts, same-day and turnaround claims not in config", async () => {
    const { deps } = await makeCtx();
    for (const text of ["That's usually $80.", "Around 120 dollars", "We can do it today!", "It takes about 2 days.", "I'll give you 10% off"]) {
      const g = guardReply(text, deps.config);
      expect(g.violations.length, text).toBeGreaterThan(0);
      expect(g.text).toBe("Let me have Jesse confirm that and get right back to you.");
    }
    expect(guardReply("Sorry to hear that.", deps.config).violations).toEqual([]);
  });

  it("allows a price that config approves", async () => {
    const { deps } = await makeCtx({ config: (c) => { c.services = [{ name: "Diagnostic", price: "$49", notes: null }]; } });
    expect(guardReply("A diagnostic is $49.", deps.config).violations).toEqual([]);
    expect(guardReply("A diagnostic is $59.", deps.config).violations).toHaveLength(1);
  });
});

describe("time rules", () => {
  it("quiet hours are 8 PM - 8 AM Eastern", async () => {
    const { deps } = await makeCtx();
    expect(isQuietHours(deps.config, et("2026-10-20 07:59"))).toBe(true);
    expect(isQuietHours(deps.config, et("2026-10-20 08:00"))).toBe(false);
    expect(isQuietHours(deps.config, et("2026-10-20 19:59"))).toBe(false);
    expect(isQuietHours(deps.config, et("2026-10-20 20:00"))).toBe(true);
    expect(quietHoursEnd(deps.config, et("2026-10-20 23:00")).toISOString()).toBe(et("2026-10-21 08:00").toISOString());
  });

  it("finds the next callback window from config, or null when unset", async () => {
    const { deps } = await makeCtx({ config: (c) => { c.callback_windows = [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "17:00", end: "18:00" }]; } });
    expect(nextCallbackWindow(deps.config, et("2026-10-20 10:00"))?.text).toBe("today between 5 PM and 6 PM");
    expect(nextCallbackWindow(deps.config, et("2026-10-23 17:45"))?.text).toBe("Monday between 5 PM and 6 PM");
    deps.config.callback_windows = null;
    expect(nextCallbackWindow(deps.config, et("2026-10-20 10:00"))).toBeNull();
  });
});

describe("helpers", () => {
  it("normalises phones and reads them back digit by digit", () => {
    expect(normalizePhone("(706) 555-1234")).toBe("+17065551234");
    expect(normalizePhone("17065551234")).toBe("+17065551234");
    expect(normalizePhone("12")).toBeNull();
    expect(spokenPhone("+17065551234")).toBe("7 0 6, 5 5 5, 1 2 3 4");
  });

  it("normalises model turns to start with the user and alternate", () => {
    expect(normalizeTurns([{ role: "assistant", content: "a" }, { role: "user", content: "b" }, { role: "user", content: "c" }])).toEqual([
      { role: "user", content: "(conversation start)" },
      { role: "assistant", content: "a" },
      { role: "user", content: "b\nc" },
    ]);
  });

  it("job dedupe keys prevent duplicate scheduling", async () => {
    const ctx = await makeCtx();
    const a = await scheduleJob(ctx.deps, { lead_id: null, type: "summary", run_at: ctx.now.t, dedupe_key: "x" });
    const b = await scheduleJob(ctx.deps, { lead_id: null, type: "summary", run_at: ctx.now.t, dedupe_key: "x" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });
});

describe("Twilio setup helper", () => {
  it("points all four webhooks at the service", async () => {
    const { webhookConfig } = await import("../src/setup-twilio.js");
    expect(webhookConfig("https://ff.onrender.com/")).toMatchObject({
      voiceUrl: "https://ff.onrender.com/voice/incoming",
      voiceFallbackUrl: "https://ff.onrender.com/voice/fallback",
      statusCallback: "https://ff.onrender.com/voice/status",
      smsUrl: "https://ff.onrender.com/sms/incoming",
    });
  });
});

describe("live AI check harness", () => {
  it("grades ideal model answers PASS and a slipped price WARN (guard caught it)", async () => {
    const { CHECKS } = await import("../src/ai-check.js");
    const { tb, turn } = await import("./helpers.js");
    const ctx = await makeCtx();
    const defer = "Let me have Jesse confirm that and get right back to you.";
    ctx.ai.push(
      turn("question", { need: "laptop screen" }, { answer_to_question: defer }),
      turn("question", {}, { answer_to_question: "A SIM unlock is $49.99." }),
      turn("question", {}, { answer_to_question: defer }),
      turn("human_request"),
      turn("upset"),
      turn("answer", { need: "laptop won't turn on", details: "HP, after an update", location: "Grovetown" }),
      turn("answer", { confirm: true }),
      tb({ name: "Maria", need: "wifi keeps dropping" }),
      tb({ reply: "I'm Jesse's automated text line — Jesse will follow up personally." }),
      tb({ reply: "Screens are $99!" }), // slips: guard must catch it
      tb({ reply: "No worries!", low_signal: true }),
    );
    const { Spy } = await import("../src/ai-check.js");
    const noDb = { query: async () => ({ rows: [], rowCount: 0 }) } as any; // ai-check runs without a database
    const deps = { ...ctx.deps, db: noDb, ai: new Spy(ctx.ai) };
    const results = [];
    for (const make of CHECKS) results.push((await make(deps).run(deps)).status);
    expect(results).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "WARN", "PASS"]);
  });
});

describe(".env handling for local tools", () => {
  it("parses, and updates a key in place or appends it", async () => {
    const { parseEnv, upsertEnvLine } = await import("../src/core/dotenv.js");
    expect(parseEnv('# c\nA=1\nB = "two words"\r\nC=\n')).toEqual({ A: "1", B: "two words", C: "" });
    expect(upsertEnvLine("A=1\nB=2\n", "B", "3")).toBe("A=1\nB=3\n");
    expect(upsertEnvLine("A=1", "C", "x")).toBe("A=1\nC=x\n");
  });
  it("recognises the entry script on any OS", async () => {
    const { isMain } = await import("../src/core/paths.js");
    const { pathToFileURL } = await import("node:url");
    const saved = process.argv[1];
    process.argv[1] = "/tmp/x/script.ts";
    expect(isMain(pathToFileURL("/tmp/x/script.ts").href)).toBe(true);
    expect(isMain(pathToFileURL("/tmp/x/other.ts").href)).toBe(false);
    process.argv[1] = saved;
  });
});
