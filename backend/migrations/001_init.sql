-- JUSTTECH Application Manager — initial schema
-- Target: Supabase / PostgreSQL 14+
-- Run this via the Supabase SQL editor, or `psql $DATABASE_URL -f migrations/001_init.sql`
-- Safe to re-run: every statement is guarded with IF NOT EXISTS / OR REPLACE.

create extension if not exists "pgcrypto"; -- gen_random_uuid()
create extension if not exists pg_trgm;    -- trigram index for fuzzy title search

-- ---------------------------------------------------------------------------
-- "Enums" -- implemented as `text` + CHECK constraints rather than native
-- Postgres enum types. This is deliberate: the SQLAlchemy models on the
-- Python side bind these columns as plain strings, and asyncpg does not
-- implicitly cast varchar -> a native enum type (it raises
-- UndefinedFunctionError on every query with an IN (...) filter). text +
-- CHECK gives the same integrity guarantee with none of that friction, and
-- is far easier to extend later (no ALTER TYPE ... ADD VALUE dance).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Applicant profiles
-- ---------------------------------------------------------------------------
create table if not exists applicant_profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  full_name text not null,
  email text not null,
  phone text,
  address jsonb default '{}'::jsonb,          -- {street, city, state, zip, country}
  links jsonb default '{}'::jsonb,             -- {linkedin, github, portfolio, website}
  skills jsonb default '[]'::jsonb,            -- ["python", "grant writing", ...]
  education jsonb default '[]'::jsonb,         -- [{school, degree, field, start, end}]
  work_history jsonb default '[]'::jsonb,      -- [{employer, title, start, end, summary}]
  eligibility jsonb default '{}'::jsonb,       -- {work_authorization, citizenship, veteran, org_type, ein, 501c3}
  preferences jsonb default '{}'::jsonb,       -- {min_salary, remote_only, locations, grant_categories}
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_profiles_active on applicant_profiles (is_active);

-- ---------------------------------------------------------------------------
-- Reusable, human-verified answers (short-answer questions, EEO, etc.)
-- ---------------------------------------------------------------------------
create table if not exists reusable_answers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references applicant_profiles(id) on delete cascade,
  question_hash text not null,                 -- sha256 of normalized question text
  question_text text not null,
  answer_text text not null,
  category text,                                -- e.g. 'eeo', 'work_auth', 'general', 'technical'
  verified boolean not null default false,      -- must be true before auto-fill can use it
  verified_at timestamptz,
  source text default 'manual',                -- 'manual' | 'imported'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, question_hash)
);

create index if not exists idx_reusable_answers_profile on reusable_answers (profile_id);

-- ---------------------------------------------------------------------------
-- Profile documents (resumes, cover letters, transcripts...)
-- ---------------------------------------------------------------------------
create table if not exists profile_documents (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references applicant_profiles(id) on delete cascade,
  doc_type text not null check (doc_type in (
    'resume', 'cover_letter', 'grant_narrative', 'transcript',
    'certification', 'writing_sample', 'other'
  )),
  title text not null,
  file_path text not null,                     -- local disk path or Supabase Storage key
  version int not null default 1,
  is_verified boolean not null default false,
  generated_by text default 'human',            -- 'human' | 'drafting_service'
  created_at timestamptz not null default now()
);

create index if not exists idx_profile_documents_profile on profile_documents (profile_id);

-- ---------------------------------------------------------------------------
-- Ingestion sources (RSS feeds, APIs, email inboxes, n8n endpoints)
-- ---------------------------------------------------------------------------
create table if not exists ingestion_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_type text not null check (source_type in ('rss', 'email', 'api', 'website', 'n8n_webhook')),
  opportunity_type text not null check (opportunity_type in ('job', 'grant')),
  config jsonb not null default '{}'::jsonb,    -- {url, imap_host, api_key_env, ...}
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_status text,
  last_error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Opportunities (jobs and grants share one table, discriminated by `type`)
-- ---------------------------------------------------------------------------
create table if not exists opportunities (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('job', 'grant')),
  source text not null,                         -- e.g. 'rss:remoteok', 'api:grants.gov'
  source_url text,
  external_id text,                              -- id/guid from the source, if any
  content_hash text not null unique,             -- sha256(type|org|title|source) for dedup
  title text not null,
  organization text,
  description text,
  location text,
  remote boolean,
  deadline timestamptz,
  eligibility jsonb default '{}'::jsonb,
  salary_min numeric,
  salary_max numeric,
  salary_currency text default 'USD',
  award_amount numeric,                          -- grants
  required_documents jsonb default '[]'::jsonb,  -- ["resume", "cover_letter", "budget_narrative"]
  application_questions jsonb default '[]'::jsonb, -- [{question, required, answer_type}]
  raw_data jsonb default '{}'::jsonb,             -- original payload, for audit/re-extraction
  status text not null default 'new' check (status in (
    'new', 'qualified', 'missing_info', 'ready_for_review',
    'submitted', 'rejected', 'follow_up', 'duplicate', 'archived'
  )),
  score int check (score between 0 and 100),
  score_breakdown jsonb default '{}'::jsonb,
  missing_fields jsonb default '[]'::jsonb,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_opportunities_type on opportunities (type);
create index if not exists idx_opportunities_status on opportunities (status);
create index if not exists idx_opportunities_deadline on opportunities (deadline);
create index if not exists idx_opportunities_score on opportunities (score desc);
create index if not exists idx_opportunities_title_trgm on opportunities using gin (title gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Applications: one profile applying to one opportunity
-- ---------------------------------------------------------------------------
create table if not exists applications (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  profile_id uuid not null references applicant_profiles(id) on delete cascade,
  status text not null default 'new' check (status in (
    'new', 'qualified', 'missing_info', 'ready_for_review',
    'submitted', 'rejected', 'follow_up'
  )),
  resume_doc_id uuid references profile_documents(id),
  cover_letter_doc_id uuid references profile_documents(id),
  narrative_doc_id uuid references profile_documents(id),
  answers jsonb default '{}'::jsonb,             -- {question_hash: answer_text}
  missing_fields jsonb default '[]'::jsonb,
  dry_run boolean not null default true,
  human_approved boolean not null default false,
  human_approved_by text,
  human_approved_at timestamptz,
  submitted_at timestamptz,
  rejected_reason text,
  follow_up_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (opportunity_id, profile_id)            -- duplicate-application protection
);

create index if not exists idx_applications_status on applications (status);
create index if not exists idx_applications_profile on applications (profile_id);

-- ---------------------------------------------------------------------------
-- Screenshots captured during Playwright form-fill runs
-- ---------------------------------------------------------------------------
create table if not exists screenshots (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  step text not null,                            -- e.g. 'before_fill', 'field_filled:email', 'stopped_at_attestation'
  file_path text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_screenshots_application on screenshots (application_id);

-- ---------------------------------------------------------------------------
-- Encrypted site credentials (Fernet-encrypted at the application layer;
-- this table only ever stores ciphertext, never plaintext)
-- ---------------------------------------------------------------------------
create table if not exists credentials (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references applicant_profiles(id) on delete cascade,
  site_domain text not null,
  username_encrypted text not null,
  secret_encrypted text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, site_domain)
);

-- ---------------------------------------------------------------------------
-- Audit log — every state-changing action
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,                     -- 'opportunity' | 'application' | 'credential' | 'profile'
  entity_id uuid not null,
  event_type text not null,                       -- 'created' | 'status_changed' | 'field_filled' | 'submitted' | ...
  actor_type text not null default 'system' check (actor_type in ('system', 'human', 'automation')),
  actor text,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_log_entity on audit_log (entity_type, entity_id);
create index if not exists idx_audit_log_created on audit_log (created_at desc);

-- ---------------------------------------------------------------------------
-- Raw inbound webhook log (n8n and others) — kept for replay/debugging
-- ---------------------------------------------------------------------------
create table if not exists webhook_log (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  payload jsonb not null,
  processed boolean not null default false,
  error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_profiles_updated on applicant_profiles;
create trigger trg_profiles_updated before update on applicant_profiles
  for each row execute function set_updated_at();

drop trigger if exists trg_opportunities_updated on opportunities;
create trigger trg_opportunities_updated before update on opportunities
  for each row execute function set_updated_at();

drop trigger if exists trg_applications_updated on applications;
create trigger trg_applications_updated before update on applications
  for each row execute function set_updated_at();

drop trigger if exists trg_reusable_answers_updated on reusable_answers;
create trigger trg_reusable_answers_updated before update on reusable_answers
  for each row execute function set_updated_at();

drop trigger if exists trg_credentials_updated on credentials;
create trigger trg_credentials_updated before update on credentials
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security. Enabling RLS is harmless for plain local Postgres:
-- the DB user that owns these tables (whichever role ran this migration,
-- e.g. `justtech` in docker-compose) bypasses RLS automatically as the
-- table owner, so the app keeps working with zero policies defined.
--
-- The `auth.role() = 'service_role'` policies below only make sense against
-- a hosted Supabase project, which provides the `auth` schema/functions.
-- Plain Postgres has no `auth` schema, so we detect it dynamically and skip
-- policy creation there instead of failing the migration.
-- ---------------------------------------------------------------------------
alter table applicant_profiles enable row level security;
alter table applications enable row level security;
alter table credentials enable row level security;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    execute 'drop policy if exists service_role_all_profiles on applicant_profiles';
    execute $p$create policy service_role_all_profiles on applicant_profiles
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role')$p$;

    execute 'drop policy if exists service_role_all_applications on applications';
    execute $p$create policy service_role_all_applications on applications
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role')$p$;

    execute 'drop policy if exists service_role_all_credentials on credentials';
    execute $p$create policy service_role_all_credentials on credentials
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role')$p$;
  else
    raise notice 'Skipping Supabase auth.role() RLS policies -- no "auth" schema found (expected on plain Postgres). Table owners still bypass RLS.';
  end if;
end $$;
