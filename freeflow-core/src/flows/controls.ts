import type { Deps } from "../core/deps.js";
import { cancelLeadJobs, pendingJobs } from "../core/jobs.js";
import { normalizePhone, prettyPhone } from "../core/phone.js";
import { getLead, getLeadByPhone, getSetting, listEvents, listMessages, logEvent, setSetting, updateLead, type Lead } from "../core/store.js";
import { fmtLocal, localDayBounds } from "../core/time.js";
import { armFollowup } from "./followup.js";

/** Manual controls shared by the CLI, the admin API and Jesse's SMS commands. */

export async function findLead(deps: Deps, phoneOrId: string): Promise<Lead | null> {
  if (/^\d{1,9}$/.test(phoneOrId)) return getLead(deps.db, Number(phoneOrId));
  const phone = normalizePhone(phoneOrId);
  return phone ? getLeadByPhone(deps.db, phone) : null;
}

/** Pause a lead: automation stops on this thread; the owner has it. */
export async function pauseLead(deps: Deps, lead: Lead, by: string): Promise<Lead> {
  const updated = await updateLead(deps.db, lead.id, { status: "human", flow: null });
  await cancelLeadJobs(deps, lead.id, `paused by ${by}`, ["followup_step", "conversation_summary"]);
  await logEvent(deps.db, lead.id, "paused", `by ${by}`, deps.clock());
  return updated;
}

/**
 * Reset a lead: back to "new", the follow-up sequence cleared and re-armed.
 * This is the only way a lead gets a second follow-up sequence. Opt-outs are
 * never reset.
 */
export async function resetLead(deps: Deps, lead: Lead, by: string): Promise<Lead> {
  await cancelLeadJobs(deps, lead.id, `reset by ${by}`);
  const updated = await updateLead(deps.db, lead.id, {
    status: "new",
    flow: null,
    flow_state: {},
    followup_started_at: null,
    thread_opened_at: deps.clock(),
  });
  await logEvent(deps.db, lead.id, "reset", `by ${by}`, deps.clock());
  await armFollowup(deps, updated);
  return updated;
}

export async function setGlobalPause(deps: Deps, paused: boolean, by: string): Promise<void> {
  await setSetting(deps.db, "automation_paused", paused);
  await logEvent(deps.db, null, paused ? "paused_all" : "resumed_all", `by ${by}`, deps.clock());
}

export async function lastAlertedLead(deps: Deps): Promise<Lead | null> {
  const id = await getSetting<number | null>(deps.db, "last_alert_lead_id", null);
  return id ? getLead(deps.db, id) : null;
}

/** Today's queue: pending jobs due before end of today (local time). */
export async function todaysQueue(deps: Deps): Promise<string[]> {
  const { end } = localDayBounds(deps.config, deps.clock());
  const jobs = (await pendingJobs(deps)).filter((j) => new Date(j.run_at) <= end);
  const lines: string[] = [];
  for (const j of jobs) {
    const lead = j.lead_id ? await getLead(deps.db, j.lead_id) : null;
    const target = lead ? `${lead.name ?? ""} ${prettyPhone(lead.phone)}`.trim() : "—";
    lines.push(`${fmtLocal(deps.config, new Date(j.run_at))}  ${j.type}${j.step_no ? ` #${j.step_no}` : ""}  ${target}`);
  }
  return lines;
}

/** Everything logged for a phone number: messages and events, in time order. */
export async function leadLog(deps: Deps, lead: Lead): Promise<string[]> {
  const msgs = await listMessages(deps.db, lead.id);
  const events = await listEvents(deps.db, lead.id);
  const rows = [
    ...msgs.map((m) => ({ at: new Date(m.at), line: `${m.direction === "inbound" ? "<<" : m.direction === "outbound" ? ">>" : "--"} [${m.channel}${m.kind ? `/${m.kind}` : ""}${m.status && m.direction === "outbound" ? ` ${m.status}` : ""}] ${m.body}` })),
    ...events.map((e) => ({ at: new Date(e.at), line: `** ${e.kind}${e.detail ? `: ${e.detail}` : ""}` })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  return [
    `${lead.name ?? "(no name)"} ${prettyPhone(lead.phone)} — status ${lead.status}${lead.opted_out_at ? " (OPTED OUT)" : ""}, source ${lead.source}, need: ${lead.need ?? "?"}`,
    ...rows.map((r) => `${fmtLocal(deps.config, r.at)}  ${r.line}`),
  ];
}
