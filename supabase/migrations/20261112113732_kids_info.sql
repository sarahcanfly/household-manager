-- School info kept off the calendar: a name, a school, a LASID, and a note.
-- This database is one household (see allowed_users). There is no household_id
-- column. Access matches tasks: a signed-in email in allowed_users can read and
-- write every row, and nobody else can.

create table public.kids (
  id         text primary key default public.short_id(),
  name       text not null check (length(trim(name)) > 0 and length(name) <= 80),
  school     text not null default '' check (length(school) <= 120),
  lasid      text not null default '' check (length(lasid) <= 32),
  notes      text not null default '' check (length(notes) <= 500),
  sort       int not null default 0,
  created_by text not null default public.current_actor(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.kids enable row level security;
create policy household_all on public.kids for all to authenticated using (public.is_household()) with check (public.is_household());

create trigger kids_touch before update on public.kids
  for each row execute function public.touch_updated_at();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.kids;
  end if;
end $$;
