-- What the household thought of "Around town" suggestions (and anything added from them),
-- so the weekly search can lean towards what they like.
create table public.event_taste (
  id         bigserial primary key,
  title      text not null check (length(trim(title)) > 0),
  kind       text not null default 'event',        -- 'event' | 'music' | 'note'
  place      text not null default '',
  vote       smallint not null check (vote in (-1, 1)),
  how        text not null default 'rated',        -- 'rated' | 'added' | 'told'
  by_email   text not null default public.current_actor(),
  created_at timestamptz not null default now()
);
create index event_taste_recent on public.event_taste (created_at desc);
alter table public.event_taste enable row level security;
create policy household_all on public.event_taste for all to authenticated using (public.is_household()) with check (public.is_household());
