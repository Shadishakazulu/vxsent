-- SENT. hardened Supabase schema
-- Apply in Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.proofs (
  id bigint primary key generated always as identity,
  proof_id text unique not null,
  file_hash text not null check (file_hash ~ '^[a-fA-F0-9]{64}$'),
  timestamp timestamptz not null default now(),
  rac_signature text,
  sender_email text not null,
  recipient_email text,
  file_name text not null,
  file_size text,
  status text not null default 'pending' check (status in ('pending', 'sealed', 'verified', 'failed', 'revoked')),
  verified_at timestamptz,
  sealed_at timestamptz,
  stripe_payment_id text,
  user_email text,
  project_name text,
  veridex_proof_id text,
  veridex_signature text,
  rac_chain_hash text,
  rac_level integer default 3,
  rac_enabled boolean default true,
  is_valid boolean default false,
  recipient_confirmed boolean default false,
  recipient_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id bigint primary key generated always as identity,
  stripe_payment_id text unique not null,
  proof_id text references public.proofs(proof_id) on delete set null,
  status text not null default 'pending',
  amount integer,
  currency text default 'usd',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.proof_access_events (
  id bigint primary key generated always as identity,
  proof_id text not null references public.proofs(proof_id) on delete cascade,
  accessed_at timestamptz not null default now(),
  ip_address text,
  user_agent text,
  referrer text,
  confirmed boolean default false
);

create index if not exists idx_proofs_proof_id on public.proofs(proof_id);
create index if not exists idx_proofs_sender_email on public.proofs(sender_email);
create index if not exists idx_proofs_recipient_email on public.proofs(recipient_email);
create index if not exists idx_proofs_created_at on public.proofs(created_at desc);
create index if not exists idx_proofs_status on public.proofs(status);
create index if not exists idx_proof_access_events_proof_id on public.proof_access_events(proof_id);

alter table public.proofs enable row level security;
alter table public.payments enable row level security;
alter table public.proof_access_events enable row level security;

drop policy if exists "Public can read sealed proofs" on public.proofs;
drop policy if exists "No anon proof inserts" on public.proofs;
drop policy if exists "No anon proof updates" on public.proofs;
drop policy if exists "No anon proof deletes" on public.proofs;

create policy "Public can read sealed proofs"
on public.proofs
for select
to anon
using (is_valid = true and status in ('sealed', 'verified'));

-- All writes must use the Supabase service role from trusted Netlify Functions.
-- Do not grant insert/update/delete to anon or authenticated client sessions.

revoke insert, update, delete on public.proofs from anon;
revoke insert, update, delete on public.proofs from authenticated;
grant select on public.proofs to anon;
grant select on public.proofs to authenticated;
grant all on public.proofs to service_role;

revoke all on public.payments from anon;
revoke all on public.payments from authenticated;
grant all on public.payments to service_role;

revoke all on public.proof_access_events from anon;
revoke all on public.proof_access_events from authenticated;
grant all on public.proof_access_events to service_role;

create or replace function public.update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists update_proofs_updated_at on public.proofs;
create trigger update_proofs_updated_at
before update on public.proofs
for each row execute function public.update_updated_at_column();

drop trigger if exists update_payments_updated_at on public.payments;
create trigger update_payments_updated_at
before update on public.payments
for each row execute function public.update_updated_at_column();
