-- A household member's own Google Calendar.
-- The refresh token is encrypted by the server and never sent to the app.
-- No security policies: like cal_map, these tables are invisible to the phones.

create table public.google_accounts (
  email text primary key check (email = lower(email)),
  google_email text not null default '',
  refresh_token text not null,
  calendar_id text not null default '',
  calendar_name text not null default '',
  last_error text not null default '',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One Google event per household event, per connected account.
-- The Google event id is how edits and deletes find the same event again,
-- and how a feed of that calendar is recognized so it is not imported twice.
create table public.personal_cal_map (
  email text not null references public.google_accounts(email) on delete cascade,
  event_id text not null,
  cal_event_id text not null,
  hash text not null,
  all_day boolean not null,
  synced_at timestamptz not null default now(),
  primary key (email, event_id)
);
create index personal_cal_map_google on public.personal_cal_map (cal_event_id);

alter table public.google_accounts enable row level security;
alter table public.personal_cal_map enable row level security;
