-- Calendars that sync straight onto the household calendar (for example a shared
-- co-parenting calendar). Each synced event remembers which calendar and which
-- event it came from, so edits and deletions there can be carried over.
alter table public.events add column if not exists feed text;
alter table public.events add column if not exists feed_uid text;
create unique index if not exists events_feed_uid on public.events (feed, feed_uid) where feed is not null;
