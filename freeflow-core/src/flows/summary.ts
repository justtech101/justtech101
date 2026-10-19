import { isCopilot, type Deps } from "../core/deps.js";
import { scheduleJob, type Job, type JobResult } from "../core/jobs.js";
import { alertOwner } from "../core/notify.js";
import { prettyPhone } from "../core/phone.js";
import { fmtLocal, localDayBounds, nextDailyTime } from "../core/time.js";

export interface DailySummary {
  newLeads: { name: string | null; phone: string; need: string | null; source: string; status: string }[];
  waitingOnOwner: { name: string | null; phone: string; body: string; at: Date }[];
  callbacksToday: { name: string | null; phone: string; at: Date | null; need: string | null }[];
  closed: { name: string | null; phone: string; detail: string | null }[];
}

export async function buildDailySummary(deps: Deps): Promise<DailySummary> {
  const now = deps.clock();
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const today = localDayBounds(deps.config, now);

  const newLeads = await deps.db.query(
    `SELECT name, phone, need, source, status FROM leads WHERE created_at >= $1 ORDER BY created_at`,
    [since],
  );
  // Leads Jesse owns whose latest message is from the customer: a reply is waiting on them.
  const waiting = await deps.db.query(
    `SELECT l.name, l.phone, m.body, m.at FROM leads l
     JOIN LATERAL (SELECT body, at, direction FROM messages WHERE lead_id = l.id AND direction <> 'note' ORDER BY at DESC, id DESC LIMIT 1) m ON true
     WHERE l.status = 'human' AND m.direction = 'inbound' AND l.opted_out_at IS NULL
     ORDER BY m.at`,
  );
  const callbacks = await deps.db.query(
    `SELECT l.name, l.phone, l.need, (j.payload->'window'->>'start')::timestamptz AS at
     FROM jobs j JOIN leads l ON l.id = j.lead_id
     WHERE j.type = 'callback' AND j.status IN ('pending','done')
       AND (j.payload->'window'->>'start')::timestamptz BETWEEN $1 AND $2
     UNION ALL
     SELECT l.name, l.phone, l.need, NULL AS at
     FROM leads l JOIN events e ON e.lead_id = l.id
     WHERE e.kind = 'booked' AND e.detail LIKE 'callback ASAP%' AND e.at >= $3 AND l.status = 'booked'
     ORDER BY at NULLS FIRST`,
    [today.start, today.end, since],
  );
  const closed = await deps.db.query(
    `SELECT l.name, l.phone, e.detail FROM events e JOIN leads l ON l.id = e.lead_id
     WHERE e.kind IN ('closed','stop') AND e.at >= $1 ORDER BY e.at`,
    [since],
  );
  return {
    newLeads: newLeads.rows,
    waitingOnOwner: waiting.rows,
    callbacksToday: callbacks.rows,
    closed: closed.rows,
  };
}

function who(r: { name: string | null; phone: string }) {
  return `${r.name ?? "(no name)"} ${prettyPhone(r.phone)}`;
}

export function formatSummary(deps: Deps, s: DailySummary): { sms: string; email: string } {
  const sms = [
    `Daily summary (${deps.config.business_name})`,
    `New leads: ${s.newLeads.length}`,
    `Replies waiting on you: ${s.waitingOnOwner.length}${s.waitingOnOwner.length ? ` — ${s.waitingOnOwner.slice(0, 3).map(who).join("; ")}` : ""}`,
    `Callbacks today: ${s.callbacksToday.length}${s.callbacksToday.length ? ` — ${s.callbacksToday.slice(0, 3).map((c) => `${who(c)}${c.at ? ` @ ${fmtLocal(deps.config, new Date(c.at))}` : " ASAP"}`).join("; ")}` : ""}`,
    `Closed: ${s.closed.length}`,
  ].join("\n");

  const section = (title: string, lines: string[]) => `${title}\n${lines.length ? lines.map((l) => `  - ${l}`).join("\n") : "  (none)"}`;
  const email = [
    `Daily summary for ${deps.config.business_name} — ${fmtLocal(deps.config, deps.clock())}`,
    "",
    section("New leads (last 24h)", s.newLeads.map((l) => `${who(l)} — ${l.need ?? "need unknown"} [${l.source}, ${l.status}]`)),
    "",
    section("Replies waiting on you", s.waitingOnOwner.map((w) => `${who(w)}: "${w.body}" (${fmtLocal(deps.config, new Date(w.at))})`)),
    "",
    section("Callbacks today", s.callbacksToday.map((c) => `${who(c)} — ${c.at ? fmtLocal(deps.config, new Date(c.at)) : "ASAP"} — ${c.need ?? ""}`)),
    "",
    section("Leads closed (last 24h)", s.closed.map((c) => `${who(c)} — ${c.detail ?? ""}`)),
  ].join("\n");
  return { sms, email };
}

export async function sendDailySummary(deps: Deps): Promise<DailySummary> {
  const summary = await buildDailySummary(deps);
  const { sms, email } = formatSummary(deps, summary);
  if (isCopilot(deps)) {
    // Google Voice mode: the owner's channel is already email, so send the full version once.
    await alertOwner(deps, email, null, { subject: `${deps.config.business_name} daily summary` });
    return summary;
  }
  await alertOwner(deps, sms);
  try {
    await deps.mailer.send(`${deps.config.business_name} daily summary`, email);
  } catch (err: any) {
    console.error("[summary] email failed", err);
    await alertOwner(deps, `Daily summary email failed to send: ${err?.message ?? err}`);
  }
  return summary;
}

/** Keep exactly one pending daily-summary job for the next 8:00 AM (dedupe by date). */
export async function ensureDailySummaryJob(deps: Deps): Promise<void> {
  const { runAt, dateKey } = nextDailyTime(deps.config, deps.clock());
  await scheduleJob(deps, { lead_id: null, type: "summary", run_at: runAt, dedupe_key: `summary:${dateKey}` });
}

export async function runDailySummaryJob(deps: Deps, _job: Job): Promise<JobResult> {
  await sendDailySummary(deps);
  return { status: "done" };
}
