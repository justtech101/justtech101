import type { Deps } from "../core/deps.js";

/**
 * Checkpoint D audit over a time window: duplicate sends, sends after STOP,
 * follow-ups after a reply, and automated sends to human-owned/booked leads.
 * Every list should be empty.
 */
export async function audit(deps: Deps, hours = 48) {
  const since = new Date(deps.clock().getTime() - hours * 3_600_000);
  const q = (sql: string) => deps.db.query(sql, [since]).then((r) => r.rows);
  return {
    duplicate_sends: await q(`
      SELECT a.lead_id, a.kind, a.body, a.at FROM messages a JOIN messages b
        ON a.lead_id = b.lead_id AND a.body = b.body AND a.id > b.id AND a.direction = 'outbound' AND b.direction = 'outbound'
       AND a.at - b.at < interval '10 minutes' AND a.status <> 'failed' AND b.status <> 'failed'
      WHERE a.at >= $1`),
    sends_after_stop: await q(`
      SELECT m.lead_id, m.kind, m.at FROM messages m JOIN leads l ON l.id = m.lead_id
      WHERE m.direction = 'outbound' AND l.opted_out_at IS NOT NULL AND m.at > l.opted_out_at AND m.at >= $1`),
    followups_after_reply: await q(`
      SELECT m.lead_id, m.kind, m.at FROM messages m
      WHERE m.direction = 'outbound' AND m.kind LIKE 'followup_step_%' AND m.at >= $1
        AND EXISTS (SELECT 1 FROM messages i WHERE i.lead_id = m.lead_id AND i.direction = 'inbound'
                    AND i.at < m.at AND i.at > (SELECT min(f.at) FROM messages f WHERE f.lead_id = m.lead_id AND f.kind = 'followup_step_1' AND f.at <= m.at))`),
    automated_sends_to_owned_leads: await q(`
      SELECT m.lead_id, m.kind, m.at FROM messages m
      WHERE m.direction = 'outbound' AND m.at >= $1
        AND m.kind IN ('opener','ai_reply','intake_question','followup_step_1','followup_step_2','followup_step_3','followup_step_4')
        AND EXISTS (SELECT 1 FROM events e WHERE e.lead_id = m.lead_id AND e.kind IN ('handoff','captured','booked','paused')
                    AND e.at < m.at
                    AND NOT EXISTS (SELECT 1 FROM events r WHERE r.lead_id = m.lead_id AND r.kind = 'reset' AND r.at > e.at AND r.at < m.at))`),
    conversations: (await q(`SELECT count(DISTINCT lead_id)::int AS n FROM messages WHERE at >= $1`))[0].n,
  };
}
