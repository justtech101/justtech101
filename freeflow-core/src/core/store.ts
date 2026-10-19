import pg from "pg";

export type Db = pg.Pool;

export function createPool(databaseUrl: string, ssl = false): Db {
  return new pg.Pool({
    connectionString: databaseUrl,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
}

export type LeadStatus = "new" | "engaged" | "booked" | "human" | "closed";
export type LeadSource = "missed_call" | "call" | "sms" | "web" | "manual";
export type Flow = "textback" | "receptionist";

export interface Lead {
  id: number;
  name: string | null;
  phone: string;
  email: string | null;
  source: LeadSource;
  need: string | null;
  service_match: string | null;
  details: string | null;
  location: string | null;
  urgency: string | null;
  callback_number: string | null;
  status: LeadStatus;
  consent_source: string;
  opted_out_at: Date | null;
  flow: Flow | null;
  flow_state: Record<string, any>;
  thread_opened_at: Date | null;
  followup_started_at: Date | null;
  created_at: Date;
  last_contact_at: Date | null;
}

export interface Message {
  id: number;
  lead_id: number;
  direction: "inbound" | "outbound" | "note";
  channel: "sms" | "voice-transcript" | "email";
  body: string;
  at: Date;
  kind: string | null;
  status: string | null;
  provider_sid: string | null;
  idempotency_key: string | null;
  error: string | null;
}

export interface EventRow {
  id: number;
  lead_id: number | null;
  kind: string;
  detail: string | null;
  at: Date;
}

// pg returns BIGSERIAL as string; cast ids to numbers at the edge.
function leadRow(r: any): Lead {
  return { ...r, id: Number(r.id) };
}

// --- Leads ---------------------------------------------------------------------

export async function getLeadByPhone(db: Db, phone: string): Promise<Lead | null> {
  const { rows } = await db.query("SELECT * FROM leads WHERE phone = $1", [phone]);
  return rows[0] ? leadRow(rows[0]) : null;
}

export async function getLead(db: Db, id: number): Promise<Lead | null> {
  const { rows } = await db.query("SELECT * FROM leads WHERE id = $1", [id]);
  return rows[0] ? leadRow(rows[0]) : null;
}

/**
 * Find a lead by phone or create one. A lead re-entering from a new channel
 * joins their existing record (dedupe on phone) — source/consent keep the
 * first contact's values.
 */
export async function upsertLead(
  db: Db,
  input: { phone: string; source: LeadSource; consent_source: string; name?: string | null; need?: string | null; email?: string | null },
  at: Date,
): Promise<{ lead: Lead; created: boolean }> {
  const { rows } = await db.query(
    `INSERT INTO leads (phone, source, consent_source, name, need, email, created_at, last_contact_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (phone) DO UPDATE SET
       last_contact_at = EXCLUDED.last_contact_at,
       name  = COALESCE(leads.name, EXCLUDED.name),
       need  = COALESCE(leads.need, EXCLUDED.need),
       email = COALESCE(leads.email, EXCLUDED.email)
     RETURNING *, (xmax = 0) AS created`,
    [input.phone, input.source, input.consent_source, input.name ?? null, input.need ?? null, input.email ?? null, at],
  );
  const { created, ...rest } = rows[0];
  return { lead: leadRow(rest), created: Boolean(created) };
}

const LEAD_UPDATABLE = new Set([
  "name", "email", "need", "service_match", "details", "location", "urgency", "callback_number",
  "status", "opted_out_at", "flow", "flow_state", "thread_opened_at", "followup_started_at", "last_contact_at",
]);

export async function updateLead(db: Db, id: number, patch: Partial<Lead>): Promise<Lead> {
  const keys = Object.keys(patch).filter((k) => LEAD_UPDATABLE.has(k));
  if (keys.length === 0) return (await getLead(db, id))!;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = keys.map((k) => {
    const v = (patch as any)[k];
    return k === "flow_state" ? JSON.stringify(v ?? {}) : v;
  });
  const { rows } = await db.query(`UPDATE leads SET ${sets} WHERE id = $1 RETURNING *`, [id, ...values]);
  return leadRow(rows[0]);
}

// --- Messages ------------------------------------------------------------------

export async function insertMessage(
  db: Db,
  m: {
    lead_id: number;
    direction: Message["direction"];
    channel: Message["channel"];
    body: string;
    at: Date;
    kind?: string | null;
    status?: string | null;
    provider_sid?: string | null;
    idempotency_key?: string | null;
  },
): Promise<Message | null> {
  const { rows } = await db.query(
    `INSERT INTO messages (lead_id, direction, channel, body, at, kind, status, provider_sid, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [m.lead_id, m.direction, m.channel, m.body, m.at, m.kind ?? null, m.status ?? null, m.provider_sid ?? null, m.idempotency_key ?? null],
  );
  return rows[0] ? { ...rows[0], id: Number(rows[0].id), lead_id: Number(rows[0].lead_id) } : null;
}

export async function getMessageByKey(db: Db, key: string): Promise<Message | null> {
  const { rows } = await db.query("SELECT * FROM messages WHERE idempotency_key = $1", [key]);
  return rows[0] ?? null;
}

export async function updateMessage(db: Db, id: number, patch: { status?: string; provider_sid?: string | null; error?: string | null }) {
  await db.query(
    `UPDATE messages SET status = COALESCE($2, status), provider_sid = COALESCE($3, provider_sid), error = COALESCE($4, error)
     WHERE id = $1`,
    [id, patch.status ?? null, patch.provider_sid ?? null, patch.error ?? null],
  );
}

export async function listMessages(db: Db, leadId: number, opts: { channel?: Message["channel"]; since?: Date } = {}): Promise<Message[]> {
  const { rows } = await db.query(
    `SELECT * FROM messages WHERE lead_id = $1
       AND ($2::text IS NULL OR channel = $2)
       AND ($3::timestamptz IS NULL OR at >= $3)
     ORDER BY at, id`,
    [leadId, opts.channel ?? null, opts.since ?? null],
  );
  return rows;
}

// --- Events (the audit log Jesse reads) ---------------------------------------

export async function logEvent(db: Db, leadId: number | null, kind: string, detail: string | null, at: Date): Promise<void> {
  await db.query("INSERT INTO events (lead_id, kind, detail, at) VALUES ($1,$2,$3,$4)", [leadId, kind, detail, at]);
}

export async function listEvents(db: Db, leadId: number): Promise<EventRow[]> {
  const { rows } = await db.query("SELECT * FROM events WHERE lead_id = $1 ORDER BY at, id", [leadId]);
  return rows;
}

// --- Settings --------------------------------------------------------------------

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = $1", [key]);
  return rows[0] ? (rows[0].value as T) : fallback;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

export async function isGloballyPaused(db: Db): Promise<boolean> {
  return getSetting(db, "automation_paused", false);
}
