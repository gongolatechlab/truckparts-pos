-- =============================================================================
-- supabase-schema.sql — run ONCE in Supabase → SQL Editor → New query → Run
-- Tables used by js/sync.js. Safe to run again (uses IF NOT EXISTS / DROP IF EXISTS).
-- =============================================================================

-- ---------- Parts catalogue (edited records: newest edit wins) ----------
create table if not exists public.parts (
  id            text primary key,
  sku           text    not null default '',
  part_number   text    not null default '',
  name          text    not null default '',
  brand         text    not null default 'Other',
  category      text    not null default '',
  location      text    not null default '',
  cost_price    numeric not null default 0,
  sell_price    numeric not null default 0,
  reorder_level integer not null default 0,
  active        boolean not null default true,
  updated_at    timestamptz not null default now(),   -- set by the phone (for "newest edit wins")
  server_ts     timestamptz not null default clock_timestamp() -- set by the server (for pulling)
);

-- ---------- Stock ledger (append-only: + purchases, - sales ...) ----------
create table if not exists public.ledger (
  id         text primary key,
  part_id    text    not null,
  type       text    not null check (type in ('OPENING','PURCHASE','RETURN','SALE','ADJUST')),
  qty        integer not null check (qty <> 0),
  unit_cost  numeric,
  unit_price numeric,
  ref_id     text,
  note       text    not null default '',
  ts         timestamptz not null,
  device     text    not null default '',
  server_ts  timestamptz not null default clock_timestamp()
);

-- ---------- Sales receipts (append-only) ----------
create table if not exists public.sales (
  id         text primary key,
  receipt_no text    not null default '',
  ts         timestamptz not null,
  items      jsonb   not null default '[]'::jsonb,
  subtotal   numeric not null default 0,
  total      numeric not null default 0,
  cost       numeric not null default 0,
  profit     numeric not null default 0,
  payment    text    not null default '',
  customer   text    not null default '',
  role       text    not null default '',
  device     text    not null default '',
  server_ts  timestamptz not null default clock_timestamp()
);

create index if not exists parts_server_ts_idx  on public.parts  (server_ts);
create index if not exists ledger_server_ts_idx on public.ledger (server_ts);
create index if not exists ledger_part_idx      on public.ledger (part_id);
create index if not exists sales_server_ts_idx  on public.sales  (server_ts);
create index if not exists sales_ts_idx         on public.sales  (ts);

-- Stamp server_ts on every insert/update so phones can ask "what changed since X?"
create or replace function public.touch_server_ts() returns trigger
language plpgsql as $$
begin
  new.server_ts := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists parts_touch  on public.parts;
drop trigger if exists ledger_touch on public.ledger;
drop trigger if exists sales_touch  on public.sales;
create trigger parts_touch  before insert or update on public.parts  for each row execute function public.touch_server_ts();
create trigger ledger_touch before insert or update on public.ledger for each row execute function public.touch_server_ts();
create trigger sales_touch  before insert or update on public.sales  for each row execute function public.touch_server_ts();

-- ---------- Row Level Security ----------
alter table public.parts  enable row level security;
alter table public.ledger enable row level security;
alter table public.sales  enable row level security;

drop policy if exists "shop read parts"   on public.parts;
drop policy if exists "shop insert parts" on public.parts;
drop policy if exists "shop update parts" on public.parts;
create policy "shop read parts"   on public.parts for select to anon using (true);
create policy "shop insert parts" on public.parts for insert to anon with check (true);
create policy "shop update parts" on public.parts for update to anon using (true) with check (true);

-- Ledger and sales: read + insert only. No update, no delete → append-only on the server too.
drop policy if exists "shop read ledger"   on public.ledger;
drop policy if exists "shop insert ledger" on public.ledger;
create policy "shop read ledger"   on public.ledger for select to anon using (true);
create policy "shop insert ledger" on public.ledger for insert to anon with check (true);

drop policy if exists "shop read sales"   on public.sales;
drop policy if exists "shop insert sales" on public.sales;
create policy "shop read sales"   on public.sales for select to anon using (true);
create policy "shop insert sales" on public.sales for insert to anon with check (true);

-- NOTE: these policies let anyone who holds your project's anon key read and add
-- shop data. Keep the key private to your shop phones. For stronger protection
-- (e.g. keeping cost prices away from staff phones) move to Supabase Auth with
-- per-role policies.
