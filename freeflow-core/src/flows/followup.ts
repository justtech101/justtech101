import type { Deps } from "../core/deps.js";
import { scheduleJob, type Job, type JobResult } from "../core/jobs.js";
import { alertOwner } from "../core/notify.js";
import { isOptOutError, sendToLead } from "../core/outbound.js";
import { prettyPhone } from "../core/phone.js";
import { loadPrompt, render, section } from "../core/prompts.js";
import { getLead, listMessages, logEvent, updateLead, type Lead } from "../core/store.js";
import { isQuietHours, quietHoursEnd } from "../core/time.js";

const NO_FOLLOWUP: Lead["status"][] = ["human", "booked", "closed"];

// Permanent Twilio failures: retrying won't help (invalid / landline / unreachable).
const PERMANENT = /\b(21211|21214|21612|21614|30006)\b/;

/** Accelerated mode (staging tests only): offsets in minutes run as seconds. */
function offsetMs(deps: Deps, minutes: number): number {
  return minutes * (deps.env.FOLLOWUP_ACCELERATED ? 1_000 : 60_000);
}

function stepOffset(deps: Deps, step: number): number {
  const s = deps.config.followup.steps.find((x) => x.step === step);
  if (!s) throw new Error(`follow-up step ${step} not configured`);
  return s.offset_minutes;
}

/**
 * (Re)arm the follow-up sequence after an automated thread goes quiet. The
 * clock restarts from the latest message until step 1 actually goes out; once
 * the sequence has started it is never restarted (one sequence per lead —
 * only Jesse's manual reset clears it).
 */
export async function armFollowup(deps: Deps, lead: Lead): Promise<void> {
  if (lead.followup_started_at || lead.opted_out_at || NO_FOLLOWUP.includes(lead.status)) return;
  const now = deps.clock();
  await deps.db.query(
    `UPDATE jobs SET status = 'cancelled', last_error = 're-armed', updated_at = $2
     WHERE lead_id = $1 AND type = 'followup_step' AND status = 'pending'`,
    [lead.id, now],
  );
  await scheduleJob(deps, {
    lead_id: lead.id,
    type: "followup_step",
    step_no: 1,
    run_at: new Date(now.getTime() + offsetMs(deps, stepOffset(deps, 1))),
    payload: { anchor: now.toISOString() },
  });
}

function serviceNote(deps: Deps, lead: Lead): string | null {
  const s = deps.config.services.find((x) => x.name === lead.service_match);
  return s?.notes ?? null;
}

export function renderFollowup(deps: Deps, lead: Lead, step: number): string {
  const prompts = loadPrompt("followup");
  const note = step === 2 ? serviceNote(deps, lead) : null;
  const key = step === 2 && !note ? "step_2_no_note" : `step_${step}`;
  return render(section(prompts, key), {
    name: lead.name ?? "there",
    need: lead.need ?? "what you reached out about",
    business_name: deps.config.business_name,
    owner_name: deps.config.owner_name,
    service_note: note,
  });
}

/** Job handler for one follow-up step. Every rule is re-checked right before the send. */
export async function runFollowupStep(deps: Deps, job: Job): Promise<JobResult> {
  const now = deps.clock();
  const step = job.step_no!;
  const lead = await getLead(deps.db, job.lead_id!);
  if (!lead) return { status: "cancelled", reason: "lead gone" };
  if (lead.opted_out_at) return { status: "cancelled", reason: "opted out" };
  if (NO_FOLLOWUP.includes(lead.status)) return { status: "cancelled", reason: `lead is ${lead.status}` };

  // Reply = stop. The inbound handler cancels jobs already; this re-check runs before every send.
  const anchor = new Date(job.payload.anchor ?? job.created_at);
  const replies = (await listMessages(deps.db, lead.id, { since: anchor })).filter((m) => m.direction === "inbound");
  if (replies.length) return { status: "cancelled", reason: "lead replied" };

  if (isQuietHours(deps.config, now)) {
    return { status: "reschedule", runAt: quietHoursEnd(deps.config, now), reason: "quiet hours" };
  }

  const res = await sendToLead(deps, lead, renderFollowup(deps, lead, step), {
    kind: `followup_step_${step}`,
    // Keyed per sequence (anchor) and step: a retry never double-texts, a manual reset gets fresh keys.
    idempotencyKey: `followup:${lead.id}:${anchor.toISOString()}:${step}`,
  });
  if (!res.ok) {
    if (res.reason === "paused") return { status: "reschedule", runAt: new Date(now.getTime() + 15 * 60_000), reason: "automation paused" };
    if (res.reason === "opted_out") return { status: "cancelled", reason: "opted out" };
    if (res.reason === "failed") {
      if (isOptOutError(res.error)) {
        await updateLead(deps.db, lead.id, { opted_out_at: now, status: "closed", flow: null });
        await logEvent(deps.db, lead.id, "stop", "carrier reports number opted out (21610)", now);
        return { status: "cancelled", reason: "opted out at carrier" };
      }
      if (PERMANENT.test(res.error ?? "")) {
        await alertOwner(deps, `Follow-up to ${prettyPhone(lead.phone)} failed permanently (${res.error}). Sequence stopped.`, lead.id);
        return { status: "cancelled", reason: `permanent send failure: ${res.error}` };
      }
      throw new Error(`follow-up send failed: ${res.error}`); // transient -> retry with backoff
    }
    // "duplicate": this step already went out (e.g. retried after a restart) — carry on.
  }

  await logEvent(deps.db, lead.id, "followup_sent", `step ${step}`, now);
  if (step === 1) await updateLead(deps.db, lead.id, { followup_started_at: now });

  if (step < 4) {
    const next = step + 1;
    const due = anchor.getTime() + offsetMs(deps, stepOffset(deps, next));
    const minGap = offsetMs(deps, (stepOffset(deps, next) - stepOffset(deps, step)) / 2);
    await scheduleJob(deps, {
      lead_id: lead.id,
      type: "followup_step",
      step_no: next,
      run_at: new Date(Math.max(due, now.getTime() + minGap)),
      payload: { anchor: anchor.toISOString() },
      dedupe_key: `followup:${lead.id}:${next}:${anchor.toISOString()}`,
    });
  } else {
    await updateLead(deps.db, lead.id, { status: "closed", flow: null });
    await logEvent(deps.db, lead.id, "closed", "no reply after follow-up step 4", now);
  }
  return { status: "done" };
}
