import type { Deps } from "../core/deps.js";
import { cancelLeadJobs, scheduleJob, type Job, type JobResult } from "../core/jobs.js";
import { alertOwner } from "../core/notify.js";
import { sendToLead } from "../core/outbound.js";
import { loadPrompt, render, section, variant } from "../core/prompts.js";
import { getLead, listMessages, logEvent, updateLead, type Lead } from "../core/store.js";
import { fmtLocal } from "../core/time.js";
import { armFollowup } from "./followup.js";
import { intakeTurn, newIntake, questionFor, summaryText, type Channel, type IntakeState } from "./intake.js";

function t(deps: Deps, key: string, extra: Record<string, string | null> = {}): string {
  return render(variant(loadPrompt("receptionist"), key, deps.env.CHANNEL), {
    business_name: deps.config.business_name,
    owner_name: deps.config.owner_name,
    ...extra,
  });
}

/** Conversation so far as model turns (oldest first, consecutive roles merged). */
export async function smsHistory(deps: Deps, lead: Lead, opener?: string) {
  // Texts plus voicemail transcripts (Google Voice mode): both are the customer talking.
  const msgs = (await listMessages(deps.db, lead.id, { since: lead.thread_opened_at ?? undefined }))
    .filter((m) => m.channel === "sms" || m.kind === "voicemail");
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  if (opener) turns.push({ role: "user", content: opener });
  for (const m of msgs) {
    if (m.direction === "note") continue;
    const role = m.direction === "inbound" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${m.body}`;
    else turns.push({ role, content: m.body });
  }
  // The API wants the conversation to start with the user.
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: "(customer contacted the business)" });
  return turns;
}

/**
 * Close out an intake (either channel): store the structured fields, set the
 * lead's status, book the callback, and send Jesse the summary — immediately,
 * well inside the 2-minute promise.
 */
export async function finalizeIntake(deps: Deps, lead: Lead, s: IntakeState, channel: Channel): Promise<void> {
  const now = deps.clock();
  const f = s.fields;
  const status = s.outcome === "booked" ? "booked" : "human";
  await updateLead(deps.db, lead.id, {
    name: f.name ?? lead.name,
    need: f.need ?? lead.need,
    service_match: f.service_match ?? lead.service_match,
    details: f.details ?? lead.details,
    location: f.location ?? lead.location,
    urgency: f.urgency ?? lead.urgency,
    callback_number: f.callback_number ?? lead.callback_number,
    status,
    flow: null,
    flow_state: { ...s },
  });
  await cancelLeadJobs(deps, lead.id, `intake ${s.outcome}`, ["followup_step", "conversation_summary"]);

  if (s.outcome === "booked") {
    if (s.window) {
      const reminderAt = new Date(new Date(s.window.start).getTime() - deps.config.summary.callback_reminder_minutes_before * 60_000);
      await scheduleJob(deps, {
        lead_id: lead.id,
        type: "callback",
        run_at: reminderAt < now ? now : reminderAt,
        payload: { window: s.window },
        dedupe_key: `callback:${lead.id}:${s.window.start}`,
      });
    }
    await logEvent(deps.db, lead.id, "booked", s.window ? s.window.text : "callback ASAP (no window configured)", now);
    await alertOwner(deps, summaryText(deps, lead.phone, s, `BOOKED callback (${channel})`), lead.id);
  } else if (s.outcome === "handoff") {
    await logEvent(deps.db, lead.id, "handoff", s.handoff_reason ?? "handoff", now);
    await alertOwner(deps, summaryText(deps, lead.phone, s, `HANDOFF — call them (${channel})`), lead.id);
  } else {
    await logEvent(deps.db, lead.id, "intake_complete", `summary path (${channel})`, now);
    await alertOwner(deps, summaryText(deps, lead.phone, s, `Intake summary (${channel})`), lead.id);
  }
}

// --- SMS channel -------------------------------------------------------------------

async function scheduleSilenceSummary(deps: Deps, lead: Lead) {
  const now = deps.clock();
  await deps.db.query(
    `UPDATE jobs SET status = 'cancelled', last_error = 'rescheduled', updated_at = $2
     WHERE lead_id = $1 AND type = 'conversation_summary' AND status = 'pending'`,
    [lead.id, now],
  );
  await scheduleJob(deps, {
    lead_id: lead.id,
    type: "conversation_summary",
    run_at: new Date(now.getTime() + deps.config.receptionist.sms_silence_summary_minutes * 60_000),
  });
}

async function smsAiFailure(deps: Deps, lead: Lead, body: string, err: unknown) {
  const now = deps.clock();
  await logEvent(deps.db, lead.id, "error", `AI error in SMS intake: ${(err as any)?.message ?? err}`, now);
  await sendToLead(deps, lead, render(variant(loadPrompt("textback"), "error_fallback", deps.env.CHANNEL), {
    owner_name: deps.config.owner_name,
  }), { kind: "error_fallback" });
  await updateLead(deps.db, lead.id, { status: "human", flow: null });
  await cancelLeadJobs(deps, lead.id, "AI error -> owner", ["followup_step", "conversation_summary"]);
  await alertOwner(deps, `AI error on text thread with ${lead.name ?? lead.phone}. They said: "${body}". Please take over.`, lead.id);
}

/** A new texter with no open thread: start the intake script over SMS. */
export async function startSmsIntake(deps: Deps, lead: Lead, body: string): Promise<void> {
  const now = deps.clock();
  const state = newIntake(lead.phone);
  lead = await updateLead(deps.db, lead.id, { flow: "receptionist", flow_state: state, thread_opened_at: now, status: "engaged" });
  await logEvent(deps.db, lead.id, "intake_started", "sms", now);
  await continueSmsIntake(deps, lead, body, { first: true });
}

export async function continueSmsIntake(deps: Deps, lead: Lead, body: string, opts: { first?: boolean } = {}): Promise<void> {
  const state = lead.flow_state as IntakeState;
  const history = (await smsHistory(deps, lead)).slice(0, -1); // the latest inbound is passed separately
  let result;
  try {
    result = await intakeTurn({ deps, channel: "sms", leadId: lead.id, history }, state, body);
  } catch (err) {
    return smsAiFailure(deps, lead, body, err);
  }
  let reply = result.reply;
  if (opts.first) {
    // A bare "hi" shouldn't count against the off-script limit.
    if (result.state.off_script > state.off_script) {
      result.state.off_script = state.off_script;
      reply = questionFor(deps, result.state, "sms");
    }
    reply = `${t(deps, "greeting_sms")} ${reply}`;
  }
  lead = await updateLead(deps.db, lead.id, { flow_state: result.state });
  await sendToLead(deps, lead, reply, { kind: result.ended ? "intake_close" : "intake_question" });
  if (result.ended) {
    await finalizeIntake(deps, lead, result.state, "sms");
  } else {
    await scheduleSilenceSummary(deps, lead);
    await armFollowup(deps, lead);
  }
}

/**
 * Job: an SMS intake went quiet mid-script. Send Jesse what we have so far.
 * The lead stays in automation so the follow-up sequence can still re-engage.
 */
export async function runConversationSummary(deps: Deps, job: Job): Promise<JobResult> {
  const lead = await getLead(deps.db, job.lead_id!);
  if (!lead || lead.flow !== "receptionist") return { status: "cancelled", reason: "thread no longer open" };
  const s = lead.flow_state as IntakeState;
  await logEvent(deps.db, lead.id, "intake_stalled", `stopped at step ${s.step}`, deps.clock());
  await alertOwner(deps, summaryText(deps, lead.phone, s, `Text intake went quiet at "${s.step}" (FYI, follow-up will continue)`), lead.id);
  return { status: "done" };
}

/** Job: 15 minutes before a booked callback window. */
export async function runCallbackReminder(deps: Deps, job: Job): Promise<JobResult> {
  const lead = await getLead(deps.db, job.lead_id!);
  if (!lead) return { status: "cancelled", reason: "lead gone" };
  const when = job.payload.window?.start ? fmtLocal(deps.config, new Date(job.payload.window.start)) : "now";
  await alertOwner(
    deps,
    `REMINDER: callback ${lead.name ?? ""} ${lead.callback_number ?? lead.phone} at ${when} — ${lead.need ?? "see summary"}`.replace(/\s+/g, " "),
    lead.id,
  );
  return { status: "done" };
}
