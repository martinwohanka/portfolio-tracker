-- Fortivio — import výpisů přes zkratku na iPhonu („Do Fortivia“ v listu sdílení)
-- Spustit jednou v Supabase → SQL Editor (celé najednou). Dá se spustit i opakovaně.
--
-- Zkratka pošle soubor výpisu (XTB, Revolut, Freedom 24…) beze změny na
-- /rest/v1/rpc/inbox_upload s hlavičkou x-import-token. Funkce ověří klíč a uloží
-- soubor do schránky import_inbox; appka ho při příštím otevření (nebo návratu
-- do popředí) naimportuje stejným kódem jako ruční import.

-- Klíče pro zkratku — v databázi jen otisk (SHA-256), samotný klíč zná jen zkratka
create table if not exists public.import_tokens (
  token_hash text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used  timestamptz
);
alter table public.import_tokens enable row level security;
drop policy if exists "vlastni klice" on public.import_tokens;
create policy "vlastni klice" on public.import_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Schránka s nahranými výpisy
create table if not exists public.import_inbox (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  filename     text,
  content      bytea,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  result       text
);
alter table public.import_inbox enable row level security;
drop policy if exists "vlastni schranka" on public.import_inbox;
create policy "vlastni schranka" on public.import_inbox for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Příjem souboru ze zkratky (volá se s veřejným klíčem, oprávnění dává x-import-token)
create or replace function public.inbox_upload(bytea) returns text
language plpgsql security definer set search_path = public as $$
declare
  hdr  json := coalesce(current_setting('request.headers', true), '{}')::json;
  tok  text := hdr ->> 'x-import-token';
  uid  uuid;
begin
  if tok is null or length(tok) < 32 then raise exception 'Chybí klíč pro import (hlavička x-import-token).'; end if;
  select user_id into uid from import_tokens
   where token_hash = encode(sha256(convert_to(tok, 'UTF8')), 'hex');
  if uid is null then raise exception 'Neplatný klíč pro import — vytvoř nový ve Fortiviu (Nastavení).'; end if;
  if $1 is null or length($1) < 20 then raise exception 'Prázdný soubor.'; end if;
  if length($1) > 10 * 1024 * 1024 then raise exception 'Soubor je větší než 10 MB.'; end if;
  insert into import_inbox (user_id, filename, content)
    values (uid, nullif(left(hdr ->> 'x-filename', 200), ''), $1);
  update import_tokens set last_used = now() where token_hash = encode(sha256(convert_to(tok, 'UTF8')), 'hex');
  delete from import_inbox where user_id = uid and processed_at < now() - interval '30 days';
  return 'Výpis přijat — naimportuje se při příštím otevření Fortivia.';
end $$;
revoke all on function public.inbox_upload(bytea) from public;
grant execute on function public.inbox_upload(bytea) to anon, authenticated;
