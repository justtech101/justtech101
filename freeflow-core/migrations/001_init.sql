-- freeflow-core schema. Rebuild from scratch with: npm run migrate -- --reset
-- The four plan tables (leads, messages, jobs, events) plus two support tables:
--   calls    — per-call voice state (Twilio CallSid -> intake progress)
--   settings — runtime switches such as the global "pause everything" flag

CREATE TABLE leads (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT,
  phone            TEXT NOT NULL UNIQUE,            -- E.164; dedupe key across channels
  email            TEXT,
  source           TEXT NOT NULL CHECK (source IN ('missed_call','call','sms','web','manual')),
  need             TEXT,                            -- what they need, verbatim or mapped to a service
  service_match    TEXT,                            -- service name from business.json, if it maps
  details          TEXT,                            -- device / service and what is happening
  location         TEXT,
  urgency          TEXT,                            -- today / this week / flexible
  callback_number  TEXT,
  status           TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','engaged','booked','human','closed')),
  consent_source   TEXT NOT NULL,                   -- how they first contacted us (never cold)
  opted_out_at     TIMESTAMPTZ,                     -- STOP: never message again, any system
  flow             TEXT CHECK (flow IN ('textback','receptionist')),  -- active automated thread
  flow_state       JSONB NOT NULL DEFAULT '{}'::jsonb,
  thread_opened_at TIMESTAMPTZ,
  followup_started_at TIMESTAMPTZ,                  -- set when follow-up step 1 is actually sent
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_contact_at  TIMESTAMPTZ
);
CREATE INDEX leads_status_idx ON leads (status);

CREATE TABLE messages (
  id               BIGSERIAL PRIMARY KEY,
  lead_id          BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK (direction IN ('inbound','outbound','note')),
  channel          TEXT NOT NULL CHECK (channel IN ('sms','voice-transcript','email')),
  body             TEXT NOT NULL,
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind             TEXT,                            -- opener, ai_reply, followup_step_2, ...
  status           TEXT,                            -- sending / sent / delivered / failed / received
  provider_sid     TEXT UNIQUE,                     -- Twilio MessageSid (dedupes webhook retries)
  idempotency_key  TEXT UNIQUE,                     -- an outbound send can never happen twice
  error            TEXT
);
CREATE INDEX messages_lead_idx ON messages (lead_id, at);

CREATE TABLE jobs (
  id               BIGSERIAL PRIMARY KEY,
  lead_id          BIGINT REFERENCES leads(id) ON DELETE CASCADE,
  type             TEXT NOT NULL
                   CHECK (type IN ('followup_step','summary','callback','conversation_summary')),
  run_at           TIMESTAMPTZ NOT NULL,
  step_no          INTEGER,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','done','cancelled','failed')),
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key       TEXT UNIQUE,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  locked_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due_idx ON jobs (status, run_at);
CREATE INDEX jobs_lead_idx ON jobs (lead_id, status);

CREATE TABLE events (
  id               BIGSERIAL PRIMARY KEY,
  lead_id          BIGINT REFERENCES leads(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,                   -- missed_call, handoff, stop, error, guardrail, alert, ...
  detail           TEXT,
  at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_lead_idx ON events (lead_id, at);
CREATE INDEX events_kind_idx ON events (kind, at);

CREATE TABLE calls (
  call_sid         TEXT PRIMARY KEY,
  lead_id          BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_number      TEXT NOT NULL,
  dial_status      TEXT,                            -- result of ringing the owner, if we did
  owner_answered   BOOLEAN NOT NULL DEFAULT false,
  state            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- intake state machine
  outcome          TEXT,                            -- booked / summary / handoff / voicemail / owner
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ
);

CREATE TABLE settings (
  key              TEXT PRIMARY KEY,
  value            JSONB NOT NULL
);
