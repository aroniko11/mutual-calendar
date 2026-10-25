-- Shared calendar: one-time database setup.
-- Paste the whole file into Supabase → SQL Editor → New query → Run. Safe to run again.
-- Before running, replace __PROJECT_URL__ below with the project URL (https://xxxx.supabase.co).

-- ---------- data ----------
create table if not exists public.events (
  id text primary key default replace(gen_random_uuid()::text, '-', ''),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.alarms (
  id text primary key default replace(gen_random_uuid()::text, '-', ''),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one row per phone that turned on notifications
create table if not exists public.push_subs (
  endpoint text primary key,
  sub jsonb not null,
  person text,                       -- aharon | tzipi | null (not chosen)
  alerts text not null default 'mine', -- mine | all | off
  user_id uuid default auth.uid(),
  user_agent text,
  updated_at timestamptz not null default now()
);
-- server-only tables (no policies → only the reminders function can read them)
create table if not exists public.push_sent (key text primary key, sent_at timestamptz not null default now());
create table if not exists public.app_secret (key text primary key, value text not null);

insert into public.app_secret (key, value)
values ('cron_secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- ---------- access: only signed-in users (Tzipi and Aharon) ----------
alter table public.events enable row level security;
alter table public.alarms enable row level security;
alter table public.push_subs enable row level security;
alter table public.push_sent enable row level security;
alter table public.app_secret enable row level security;

drop policy if exists family on public.events;
create policy family on public.events for all to authenticated using (true) with check (true);
drop policy if exists family on public.alarms;
create policy family on public.alarms for all to authenticated using (true) with check (true);
drop policy if exists family on public.push_subs;
create policy family on public.push_subs for all to authenticated using (true) with check (true);

-- the public half of the push key, created by the reminders function on its first run
create or replace function public.vapid_public_key() returns text
language sql stable security definer set search_path = public
as $$ select value from public.app_secret where key = 'vapid_public' $$;
revoke all on function public.vapid_public_key() from public, anon;
grant execute on function public.vapid_public_key() to authenticated;

-- live updates between the two phones
do $$ begin
  begin alter publication supabase_realtime add table public.events; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.alarms; exception when duplicate_object then null; end;
end $$;

-- ---------- attachments (private bucket, up to 50MB per file) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "family read" on storage.objects;
create policy "family read" on storage.objects for select to authenticated using (bucket_id = 'attachments');
drop policy if exists "family write" on storage.objects;
create policy "family write" on storage.objects for insert to authenticated with check (bucket_id = 'attachments');
drop policy if exists "family update" on storage.objects;
create policy "family update" on storage.objects for update to authenticated using (bucket_id = 'attachments');
drop policy if exists "family delete" on storage.objects;
create policy "family delete" on storage.objects for delete to authenticated using (bucket_id = 'attachments');

-- ---------- run the reminders function every minute ----------
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('send-reminders') where exists (select 1 from cron.job where jobname = 'send-reminders');
select cron.schedule('send-reminders', '* * * * *', $cron$
  select net.http_post(
    url := '__PROJECT_URL__/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from public.app_secret where key = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
$cron$);

-- keep the "already sent" log short
select cron.unschedule('trim-push-log') where exists (select 1 from cron.job where jobname = 'trim-push-log');
select cron.schedule('trim-push-log', '17 3 * * *', $cron$ delete from public.push_sent where sent_at < now() - interval '30 days' $cron$);
