-- Change alerts: when one of you adds, edits, cancels or deletes an event, the other phone gets a notification
-- that opens the event with an "add to the iPhone calendar" button. Run once in SQL Editor. Safe to run again.

create extension if not exists pgcrypto with schema extensions;

-- queue of changes, sent by the send-reminders function on its next run (within a minute)
create table if not exists public.event_changes (
  id bigint generated always as identity primary key,
  event_id text not null,
  kind text not null,          -- insert | update | cancel | delete
  user_id uuid,                -- who made the change (their own phones are skipped)
  data jsonb,
  at timestamptz not null default now(),
  sent boolean not null default false
);
alter table public.event_changes enable row level security;

create or replace function public.log_event_change() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then return null; end if; -- changes made from the dashboard are not announced
  if tg_op = 'INSERT' then
    insert into public.event_changes (event_id, kind, user_id, data) values (new.id, 'insert', auth.uid(), new.data);
  elsif tg_op = 'DELETE' then
    insert into public.event_changes (event_id, kind, user_id, data) values (old.id, 'delete', auth.uid(), old.data);
  elsif new.data is distinct from old.data then
    insert into public.event_changes (event_id, kind, user_id, data) values (new.id,
      case when coalesce(new.data->>'status', 'active') = 'cancelled' and coalesce(old.data->>'status', 'active') <> 'cancelled' then 'cancel' else 'update' end,
      auth.uid(), new.data);
  end if;
  return null;
end $$;

drop trigger if exists events_changed on public.events;
create trigger events_changed after insert or update or delete on public.events
for each row execute function public.log_event_change();

-- per phone: whether to get these alerts
alter table public.push_subs add column if not exists notify_changes boolean not null default true;

-- signed link to an event's .ics file (served by the send-reminders function)
create or replace function public.ics_token(p_id text) returns text
language sql stable security definer set search_path = public, extensions
as $$ select encode(extensions.hmac(p_id, (select value from public.app_secret where key = 'cron_secret'), 'sha256'), 'hex') $$;
revoke all on function public.ics_token(text) from public, anon;
grant execute on function public.ics_token(text) to authenticated;

-- keep the change log short
select cron.unschedule('trim-change-log') where exists (select 1 from cron.job where jobname = 'trim-change-log');
select cron.schedule('trim-change-log', '27 3 * * *', $cron$ delete from public.event_changes where at < now() - interval '30 days' $cron$);
