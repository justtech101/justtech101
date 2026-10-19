import { DateTime } from "luxon";
import request from "supertest";
import type { z } from "zod";
import { buildApp } from "../src/app.js";
import type { Ai, AiTurn } from "../src/core/ai.js";
import { loadBusinessConfig, loadEnv, type BusinessConfig } from "../src/core/config.js";
import type { Deps } from "../src/core/deps.js";
import { NullMailer } from "../src/core/notify.js";
import { FakeGmail } from "../src/core/gmail.js";
import { createPool, type Db } from "../src/core/store.js";
import { FakeTelephony } from "../src/core/telephony.js";
import { runDueJobs } from "../src/core/jobs.js";
import { jobHandlers } from "../src/flows/handlers.js";
import { migrate } from "../src/migrate.js";
import type { TurnOutput } from "../src/flows/intake.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5433/freeflow_test";
export const OWNER = "+17065550000";
export const CALLER = "+17065551234";
export const BUSINESS = "+17065550100";

export type AiHandler = (args: { system: string; messages: AiTurn[] }) => unknown;

/** Scripted model: each call pops the next handler (or reuses a single function). */
export class FakeAi implements Ai {
  calls: { system: string; messages: AiTurn[] }[] = [];
  queue: (AiHandler | Error)[] = [];
  push(...h: (AiHandler | Error | Record<string, unknown>)[]) {
    for (const x of h) this.queue.push(typeof x === "function" || x instanceof Error ? (x as any) : () => x);
    return this;
  }
  async structured<S extends z.ZodType>(args: { system: string; messages: AiTurn[]; schema: S }): Promise<z.infer<S>> {
    this.calls.push(args);
    const next = this.queue.shift();
    if (!next) throw new Error("FakeAi: no scripted response left");
    if (next instanceof Error) throw next;
    return args.schema.parse(next(args)); // same validation the real wrapper applies
  }
}

let pool: Db | null = null;
export async function db(): Promise<Db> {
  if (!pool) {
    pool = createPool(TEST_DB);
    await migrate(pool, { reset: true });
  }
  return pool;
}

export async function resetDb(): Promise<void> {
  const d = await db();
  await d.query("TRUNCATE leads, messages, jobs, events, calls, settings RESTART IDENTITY CASCADE");
}

/** Eastern-time helper: et("2026-10-20 10:00"). */
export function et(s: string): Date {
  return DateTime.fromFormat(s, "yyyy-MM-dd HH:mm", { zone: "America/New_York" }).toJSDate();
}

export interface TestCtx {
  gmail: FakeGmail;
  deps: Deps;
  tel: FakeTelephony;
  ai: FakeAi;
  mailer: NullMailer;
  now: { t: Date };
  advance(minutes: number): void;
  app: ReturnType<typeof buildApp>;
  post(path: string, body: Record<string, string>): Promise<request.Response>;
  runJobs(): Promise<number>;
  ownerTexts(): string[];
  leadTexts(phone?: string): string[];
}

export async function makeCtx(opts: { config?: (c: BusinessConfig) => void; env?: Record<string, string>; at?: Date } = {}): Promise<TestCtx> {
  const config = structuredClone(loadBusinessConfig());
  opts.config?.(config);
  const env = loadEnv({
    DATABASE_URL: TEST_DB,
    PUBLIC_BASE_URL: "https://test.example",
    DEPLOY_ENV: "production",
    OWNER_ALERT_NUMBER: OWNER,
    TWILIO_PHONE_NUMBER: BUSINESS,
    TWILIO_VALIDATE_SIGNATURES: "false",
    ADMIN_API_KEY: "test-admin-key",
    ANTHROPIC_API_KEY: "test-not-used", // the FakeAi is injected; this only marks the AI layer as configured
    ...opts.env,
  });
  const now = { t: opts.at ?? et("2026-10-20 10:00") }; // a Tuesday morning
  const tel = new FakeTelephony();
  const ai = new FakeAi();
  const mailer = new NullMailer();
  const gmail = new FakeGmail();
  const deps: Deps = { db: await db(), telephony: tel, ai, mailer, config, env, clock: () => now.t, gmail };
  const app = buildApp(deps);
  return {
    gmail, deps, tel, ai, mailer, now, app,
    advance(minutes) {
      now.t = new Date(now.t.getTime() + minutes * 60_000);
    },
    post: (path, body) => request(app).post(path).type("form").send(body),
    runJobs: () => runDueJobs(deps, jobHandlers),
    ownerTexts: () => tel.to(OWNER).map((m) => m.body),
    leadTexts: (phone = CALLER) => tel.to(phone).map((m) => m.body),
  };
}

let sid = 0;
export const nextSid = (p = "SM") => `${p}test${++sid}`;

/** Simulate a Twilio inbound text and wait for background processing to finish. */
export async function textIn(ctx: TestCtx, body: string, from = CALLER) {
  const { handleInboundSms } = await import("../src/flows/inbound.js");
  await handleInboundSms(ctx.deps, { from, body, sid: nextSid() });
}

export async function events(ctx: TestCtx, kind?: string) {
  const { rows } = await ctx.deps.db.query(
    "SELECT * FROM events WHERE ($1::text IS NULL OR kind = $1) ORDER BY id",
    [kind ?? null],
  );
  return rows;
}

export async function leadByPhone(ctx: TestCtx, phone = CALLER) {
  const { rows } = await ctx.deps.db.query("SELECT * FROM leads WHERE phone = $1", [phone]);
  return rows[0];
}

export async function jobs(ctx: TestCtx, status?: string) {
  const { rows } = await ctx.deps.db.query("SELECT * FROM jobs WHERE ($1::text IS NULL OR status = $1) ORDER BY id", [status ?? null]);
  return rows;
}

/** Textback model output with sensible defaults. */
export const tb = (o: Partial<{ reply: string; name: string | null; need: string | null; low_signal: boolean; wants_human: boolean; upset: boolean }>) => ({
  reply: "Got it — what's going on with it?",
  name: null,
  need: null,
  low_signal: false,
  wants_human: false,
  upset: false,
  ...o,
});

type Extracted = TurnOutput["extracted"];
const emptyX: Extracted = { need: null, service_match: null, details: null, location: null, in_service_area: null, urgency: null, name: null, callback_number: null, confirm: null };
/** Intake model output with sensible defaults. */
export const turn = (intent: TurnOutput["intent"], x: Partial<Extracted> = {}, extra: { ack?: string | null; answer_to_question?: string | null } = {}) => ({
  intent,
  extracted: { ...emptyX, ...x },
  ack: extra.ack ?? null,
  answer_to_question: extra.answer_to_question ?? null,
});
