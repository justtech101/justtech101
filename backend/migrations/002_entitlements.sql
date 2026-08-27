-- JustTech Pro entitlements (single-install billing state).
-- Safe to re-run.

create table if not exists entitlements (
  id uuid primary key default gen_random_uuid(),
  plan text not null default 'free'
    check (plan in ('free', 'pro')),
  status text not null default 'inactive'
    check (status in ('inactive', 'active', 'past_due', 'canceled')),
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_checkout_session_id text,
  valid_until timestamptz,
  license_key_fingerprint text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- At most one entitlement row per install (application-enforced singleton + seed).
create unique index if not exists entitlements_singleton_idx
  on entitlements ((true));

insert into entitlements (plan, status)
select 'free', 'inactive'
where not exists (select 1 from entitlements);
