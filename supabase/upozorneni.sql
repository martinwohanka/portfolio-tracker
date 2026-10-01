-- Fortivio — upozornění na pohyb cen (Web Push)
-- Spustit jednou v Supabase → SQL Editor (celé najednou). Dá se spustit i opakovaně.
-- Předtím nasadit Edge Function „price-alerts“ (supabase/functions/price-alerts/index.ts).
-- <ANON_KEY> nahradit veřejným klíčem z web/index.html (CONFIG.SUPABASE_ANON_KEY).

-- Odběry notifikací — jeden řádek za každé zařízení (iPhone, Mac…)
create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  device     text,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "vlastni odbery" on public.push_subs;
create policy "vlastni odbery" on public.push_subs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Nastavení upozornění + seznam držených titulů (appka ho aktualizuje při každém načtení)
create table if not exists public.alert_settings (
  user_id             uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  threshold           numeric not null default 2,
  portfolio_threshold numeric not null default 2,
  watchlist           boolean not null default true,
  extended            boolean not null default true,
  portfolio           boolean not null default true,
  holdings            jsonb   not null default '[]'::jsonb,
  providers           jsonb,                       -- brokeři pro hlídání pozic, null = všichni
  updated_at          timestamptz not null default now()
);
alter table public.alert_settings add column if not exists providers jsonb;   -- pro databáze z verze v3.22
alter table public.alert_settings enable row level security;
drop policy if exists "vlastni nastaveni" on public.alert_settings;
create policy "vlastni nastaveni" on public.alert_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Co už bylo ohlášeno (titul, den, úroveň) — jen pro server, appka sem nevidí
create table if not exists public.alert_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker  text not null,
  day     date not null,
  lvl     int  not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, ticker, day)
);
alter table public.alert_log enable row level security;

-- Klíče serveru (VAPID se vytvoří samy při prvním volání funkce) — jen pro server
create table if not exists public.push_config (
  id            int primary key default 1 check (id = 1),
  cron_secret   text not null default gen_random_uuid()::text,
  vapid_public  text,
  vapid_private text
);
alter table public.push_config enable row level security;
insert into public.push_config (id) values (1) on conflict do nothing;

-- Spouštění každých 5 minut (funkce sama nic nedělá mimo 8:55–2:10 v pracovní dny)
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('fortivio-upozorneni') where exists (select 1 from cron.job where jobname = 'fortivio-upozorneni');
select cron.schedule('fortivio-upozorneni', '*/5 * * * *', $$
  select net.http_post(
    url     := 'https://gqzkhvdnnndtvyvxmctx.supabase.co/functions/v1/price-alerts',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <ANON_KEY>',
      'x-cron-secret', (select cron_secret from public.push_config where id = 1)),
    body    := '{"action":"run"}'::jsonb,
    timeout_milliseconds := 60000);
$$);
