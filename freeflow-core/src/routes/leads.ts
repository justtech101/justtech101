import { Router, type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Deps } from "../core/deps.js";
import { alertOwner } from "../core/notify.js";
import { pendingJobs, runDueJobs } from "../core/jobs.js";
import { normalizePhone } from "../core/phone.js";
import { listEvents, listMessages, upsertLead } from "../core/store.js";
import { findLead, leadLog, pauseLead, resetLead, setGlobalPause, todaysQueue } from "../flows/controls.js";
import { armFollowup } from "../flows/followup.js";
import { jobHandlers } from "../flows/handlers.js";
import { sendDailySummary } from "../flows/summary.js";

function adminAuth(deps: Deps) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = deps.env.ADMIN_API_KEY;
    const given = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const ok = key.length > 0 && given.length === key.length && timingSafeEqual(Buffer.from(given), Buffer.from(key));
    if (!ok) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

const NewLead = z.object({
  phone: z.string(),
  name: z.string().optional(),
  need: z.string().optional(),
  email: z.string().optional(),
  source: z.enum(["web", "manual"]).default("manual"),
  // Phase 1 never cold-contacts anyone: every manual lead records how they consented.
  consent_source: z.string().min(3),
  start_followup: z.boolean().default(false),
});

/** Admin API (bearer ADMIN_API_KEY). Phase 1 has no admin panel — these back the CLI and checkpoint tests. */
export function leadRoutes(deps: Deps): Router {
  const r = Router();
  const auth = adminAuth(deps);
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      if (err instanceof z.ZodError) return void res.status(400).json({ error: "invalid request", issues: err.issues });
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  };

  r.post("/leads", auth, wrap(async (req, res) => {
    const body = NewLead.parse(req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) return res.status(400).json({ error: "invalid phone" });
    const { lead, created } = await upsertLead(deps.db, { phone, source: body.source, consent_source: body.consent_source, name: body.name, need: body.need, email: body.email }, deps.clock());
    if (body.start_followup) await armFollowup(deps, lead);
    res.status(created ? 201 : 200).json({ lead, created });
  }));

  r.get("/leads/:phone", auth, wrap(async (req, res) => {
    const lead = await findLead(deps, String(req.params.phone));
    if (!lead) return res.status(404).json({ error: "not found" });
    res.json({
      lead,
      messages: await listMessages(deps.db, lead.id),
      events: await listEvents(deps.db, lead.id),
      jobs: await pendingJobs(deps, lead.id),
      log: await leadLog(deps, lead),
    });
  }));

  r.post("/leads/:phone/pause", auth, wrap(async (req, res) => {
    const lead = await findLead(deps, String(req.params.phone));
    if (!lead) return res.status(404).json({ error: "not found" });
    res.json({ lead: await pauseLead(deps, lead, "admin api") });
  }));

  r.post("/leads/:phone/reset", auth, wrap(async (req, res) => {
    const lead = await findLead(deps, String(req.params.phone));
    if (!lead) return res.status(404).json({ error: "not found" });
    res.json({ lead: await resetLead(deps, lead, "admin api") });
  }));

  r.post("/admin/pause-all", auth, wrap(async (_req, res) => {
    await setGlobalPause(deps, true, "admin api");
    res.json({ paused: true });
  }));
  r.post("/admin/resume-all", auth, wrap(async (_req, res) => {
    await setGlobalPause(deps, false, "admin api");
    res.json({ paused: false });
  }));
  r.get("/admin/queue", auth, wrap(async (_req, res) => {
    res.json({ queue: await todaysQueue(deps) });
  }));
  // Checkpoint A: run the daily summary on demand.
  r.post("/admin/summary", auth, wrap(async (_req, res) => {
    res.json({ summary: await sendDailySummary(deps) });
  }));
  // Checkpoint A: a test SMS through the deployed service (goes to the owner's alert number).
  r.post("/admin/test-sms", auth, wrap(async (req, res) => {
    const text = String(req.body?.body ?? `Test from freeflow-core (${deps.env.DEPLOY_ENV}). Reply HELP to see commands.`);
    res.json({ sent: await alertOwner(deps, text) });
  }));
  r.post("/admin/run-jobs", auth, wrap(async (_req, res) => {
    res.json({ processed: await runDueJobs(deps, jobHandlers) });
  }));
  return r;
}
