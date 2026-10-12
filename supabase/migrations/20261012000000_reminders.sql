-- Repeating reminders ("trash and recycling, Fridays at 7am"), sent as phone notifications.
-- holiday: what to do in a week with a weekday holiday on or before the reminder day
-- (Framingham delays collection a day after a holiday): 'skip', 'shift' (one day later), or 'none'.
create table public.reminders (
  id          text primary key default public.short_id(),
  title       text not null check (length(trim(title)) > 0),
  note        text not null default '',
  days        smallint[] not null check (cardinality(days) > 0),   -- 0 Sunday … 6 Saturday
  hour        smallint not null check (hour between 0 and 23),
  every_weeks smallint not null default 1 check (every_weeks between 1 and 4),
  start_date  date not null default public.hm_today(),
  holiday     text not null default 'none' check (holiday in ('none', 'skip', 'shift')),
  created_by  text not null default public.current_actor(),
  created_at  timestamptz not null default now()
);
alter table public.reminders enable row level security;
create policy household_all on public.reminders for all to authenticated using (public.is_household()) with check (public.is_household());
