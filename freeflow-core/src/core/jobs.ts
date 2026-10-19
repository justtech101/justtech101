import type { Deps } from "./deps.js";
import { alertOwner } from "./notify.js";
import { logEvent } from "./store.js";

export type JobType = "followup_step" | "summary" | "callback" | "conversation_summary";

export interface Job {
  id: number;
  lead_id: number | null;
  type: JobType;
  run_at: Date;
  step_no: number | null;
  status: "pending" | "running" | "done" | "cancelled" | "failed";
  payload: Record<string, any>;
  dedupe_key: string | null;
  attempts: number;
  created_at: Date;
}

/** What a handler decided. "reschedule" puts the job back with a new run_at (e.g. quiet hours). */
export type JobResult = { status: "done" } | { status: "cancelled"; reason: string } | { status: "reschedule"; runAt: Date; reason: string };

export type JobHandler = (deps: Deps, job: Job) => Promise<JobResult>;
export type JobHandlers = Record<JobType, JobHandler>;

const MAX_ATTEMPTS = 3;

function jobRow(r: any): Job {
  return { ...r, id: Number(r.id), lead_id: r.lead_id === null ? null : Number(r.lead_id) };
}

export async function scheduleJob(
  deps: Deps,
  job: { lead_id: number | null; type: JobType; run_at: Date; step_no?: number | null; payload?: Record<string, any>; dedupe_key?: string | null },
): Promise<Job | null> {
  const now = deps.clock();
  const { rows } = await deps.db.query(
    `INSERT INTO jobs (lead_id, type, run_at, step_no, payload, dedupe_key, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING *`,
    [job.lead_id, job.type, job.run_at, job.step_no ?? null, JSON.stringify(job.payload ?? {}), job.dedupe_key ?? null, now],
  );
  return rows[0] ? jobRow(rows[0]) : null;
}

/** Cancel pending jobs for a lead (all types, or only the given ones). Returns how many. */
export async function cancelLeadJobs(deps: Deps, leadId: number, reason: string, types?: JobType[]): Promise<number> {
  const { rowCount } = await deps.db.query(
    `UPDATE jobs SET status = 'cancelled', last_error = $3, updated_at = $4
     WHERE lead_id = $1 AND status = 'pending' AND ($2::text[] IS NULL OR type = ANY($2))`,
    [leadId, types ?? null, reason, deps.clock()],
  );
  if (rowCount) await logEvent(deps.db, leadId, "jobs_cancelled", `${rowCount} pending job(s): ${reason}`, deps.clock());
  return rowCount ?? 0;
}

export async function pendingJobs(deps: Deps, leadId?: number): Promise<Job[]> {
  const { rows } = await deps.db.query(
    `SELECT * FROM jobs WHERE status = 'pending' AND ($1::bigint IS NULL OR lead_id = $1) ORDER BY run_at, id`,
    [leadId ?? null],
  );
  return rows.map(jobRow);
}

/**
 * Claim one due job atomically. SKIP LOCKED means two pollers (or a deploy
 * overlap) can never run the same job.
 */
async function claimNext(deps: Deps): Promise<Job | null> {
  const now = deps.clock();
  const { rows } = await deps.db.query(
    `UPDATE jobs SET status = 'running', locked_at = $1, attempts = attempts + 1, updated_at = $1
     WHERE id = (
       SELECT id FROM jobs WHERE status = 'pending' AND run_at <= $1
       ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [now],
  );
  return rows[0] ? jobRow(rows[0]) : null;
}

async function finish(deps: Deps, job: Job, result: JobResult): Promise<void> {
  const now = deps.clock();
  if (result.status === "reschedule") {
    await deps.db.query(
      `UPDATE jobs SET status = 'pending', run_at = $2, locked_at = NULL, attempts = 0, last_error = $3, updated_at = $4 WHERE id = $1`,
      [job.id, result.runAt, result.reason, now],
    );
  } else {
    await deps.db.query(`UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL, updated_at = $4 WHERE id = $1`, [
      job.id,
      result.status,
      result.status === "cancelled" ? result.reason : null,
      now,
    ]);
  }
}

/** Run every job that is due now. Returns the number processed. */
export async function runDueJobs(deps: Deps, handlers: JobHandlers): Promise<number> {
  let count = 0;
  for (let job = await claimNext(deps); job; job = await claimNext(deps)) {
    count++;
    try {
      await finish(deps, job, await handlers[job.type](deps, job));
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const now = deps.clock();
      await logEvent(deps.db, job.lead_id, "error", `job ${job.id} (${job.type}) failed: ${msg}`, now);
      if (job.attempts >= MAX_ATTEMPTS) {
        await deps.db.query(`UPDATE jobs SET status = 'failed', last_error = $2, updated_at = $3 WHERE id = $1`, [job.id, msg, now]);
        await alertOwner(deps, `System error: job ${job.type} #${job.id} failed ${job.attempts}x: ${msg}`, job.lead_id);
      } else {
        // Back off and retry. Sends inside the job are idempotent, so a retry never double-texts.
        await deps.db.query(
          `UPDATE jobs SET status = 'pending', run_at = $2, last_error = $3, locked_at = NULL, updated_at = $4 WHERE id = $1`,
          [job.id, new Date(now.getTime() + 60_000 * job.attempts), msg, now],
        );
      }
    }
  }
  return count;
}

/**
 * After a crash or redeploy, jobs left in 'running' go back to 'pending'.
 * Their sends are keyed, so re-running them cannot double-text a lead.
 */
export async function recoverStaleJobs(deps: Deps, olderThanMinutes = 5): Promise<number> {
  const now = deps.clock();
  const { rowCount } = await deps.db.query(
    `UPDATE jobs SET status = 'pending', locked_at = NULL, updated_at = $1
     WHERE status = 'running' AND locked_at < $2`,
    [now, new Date(now.getTime() - olderThanMinutes * 60_000)],
  );
  return rowCount ?? 0;
}

/** Poll the jobs table on an interval. `beforeTick` lets the app keep the daily summary scheduled. */
export function startPoller(deps: Deps, handlers: JobHandlers, opts: { intervalMs: number; beforeTick?: () => Promise<void> }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await recoverStaleJobs(deps);
      await opts.beforeTick?.();
      await runDueJobs(deps, handlers);
    } catch (err) {
      console.error("[poller] tick failed", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, opts.intervalMs);
  void tick();
  return () => clearInterval(timer);
}
