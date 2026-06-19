-- ═══════════════════════════════════════════════════════════════════════════════
-- FlightLog — Supabase SQL Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════════


-- ── 1. PROFILES ───────────────────────────────────────────────────────────────
-- Extends Supabase's built-in auth.users table with app-specific fields.
-- A row is auto-created here whenever someone signs up (see trigger below).

create table if not exists public.profiles (
  id       uuid references auth.users(id) on delete cascade primary key,
  name     text not null default '',
  plan     text not null default 'starter'  check (plan in ('starter','pro','enterprise','admin')),
  role     text not null default 'pilot'    check (role in ('pilot','admin')),
  joined   date not null default current_date,
  active   boolean not null default true,
  rapidapi_key text  -- encrypted at rest; stored here so user doesn't re-enter it
);

comment on table public.profiles is 'One row per registered user, linked to auth.users.';


-- ── 2. ROSTERS ────────────────────────────────────────────────────────────────
-- Each uploaded roster is one row. The full calendar (all days + flights) is
-- stored as JSONB — fast to query, easy to return to the React app as-is.

create table if not exists public.rosters (
  id           uuid default gen_random_uuid() primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  period_label text not null,          -- e.g. "Jun 2026"
  year         integer not null,
  month_num    integer not null,       -- 0-indexed (Jan=0, Dec=11)
  calendar     jsonb not null,         -- array of { day, dow, isOff, flights[] }
  uploaded_at  timestamptz not null default now()
);

create index if not exists rosters_user_id_idx on public.rosters(user_id);
create index if not exists rosters_uploaded_at_idx on public.rosters(uploaded_at desc);

comment on table public.rosters is 'One row per uploaded monthly roster PDF.';


-- ── 3. TAIL LOGS ──────────────────────────────────────────────────────────────
-- Stores the tail number a pilot has confirmed for each individual flight leg.
-- flight_key is "{dayIndex}-{flightIndex}" within a roster.

create table if not exists public.tail_logs (
  id           uuid default gen_random_uuid() primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  roster_id    uuid not null references public.rosters(id) on delete cascade,
  flight_key   text not null,          -- e.g. "14-2"  (day 14, leg index 2)
  tail_number  text not null default '',
  updated_at   timestamptz not null default now(),
  unique (user_id, roster_id, flight_key)
);

create index if not exists tail_logs_user_roster_idx on public.tail_logs(user_id, roster_id);

comment on table public.tail_logs is 'Aircraft tail numbers logged per flight leg.';


-- ── 4. SUBSCRIPTIONS (optional — use if not delegating to Stripe) ─────────────

create table if not exists public.subscriptions (
  id                 uuid default gen_random_uuid() primary key,
  user_id            uuid not null references public.profiles(id) on delete cascade unique,
  stripe_customer_id text,
  stripe_sub_id      text,
  plan               text not null default 'starter',
  status             text not null default 'active',  -- active | past_due | cancelled
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);

comment on table public.subscriptions is 'Stripe subscription metadata per user.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- Every table is locked down so users can only touch their own rows.
-- Admin access is handled via a service_role key in Edge Functions.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.profiles      enable row level security;
alter table public.rosters       enable row level security;
alter table public.tail_logs     enable row level security;
alter table public.subscriptions enable row level security;

-- profiles: each user reads/updates only their own row
create policy "profiles: own row"
  on public.profiles for all
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- rosters: each user manages only their own rosters
create policy "rosters: own rows"
  on public.rosters for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- tail_logs: each user manages only their own logs
create policy "tail_logs: own rows"
  on public.tail_logs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- subscriptions: each user reads only their own
create policy "subscriptions: own row"
  on public.subscriptions for select
  using (auth.uid() = user_id);


-- ═══════════════════════════════════════════════════════════════════════════════
-- TRIGGER — auto-create profile on sign-up
-- Fires after a new row is inserted into auth.users (i.e. on every sign-up).
-- Reads name and plan from the metadata passed during signUp().
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, plan, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'plan', 'starter'),
    'pilot'
  );
  return new;
end;
$$;

-- Drop and recreate trigger cleanly
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- ═══════════════════════════════════════════════════════════════════════════════
-- ADMIN VIEW — safe read-only view joining profiles + rosters
-- Admins query this through a service_role Edge Function (never from browser).
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace view public.admin_user_summary as
select
  p.id,
  p.name,
  p.plan,
  p.role,
  p.joined,
  p.active,
  u.email,
  count(distinct r.id)   as roster_count,
  count(distinct tl.id)  as tail_logs_count
from public.profiles p
join auth.users u on u.id = p.id
left join public.rosters r on r.user_id = p.id
left join public.tail_logs tl on tl.user_id = p.id
group by p.id, p.name, p.plan, p.role, p.joined, p.active, u.email;

comment on view public.admin_user_summary is
  'Read-only admin view. Only accessible via service_role key in Edge Functions.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- SEED — create the admin account
-- After running this, sign up at your app with admin@flightlog.app
-- then run the UPDATE below with the UUID Supabase assigns to that user.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Step 1: Sign up normally at your app with admin@flightlog.app
-- Step 2: Find the UUID in Supabase → Authentication → Users
-- Step 3: Run this (replace the UUID):
--
-- update public.profiles
-- set role = 'admin', plan = 'admin', name = 'Admin'
-- where id = 'PASTE-ADMIN-UUID-HERE';
