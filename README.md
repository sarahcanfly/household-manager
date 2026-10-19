# Household Manager

A shared household calendar with an agent. Add things by typing or talking ("add a dentist appointment
for Leo on December 2 at 2pm"), approve what it finds in forwarded emails, photos of flyers and the
school calendar, and see it all on a shared Google Calendar, with a weekly summary and evening-before
reminders by email and text.

**Setting it up:** see [SETUP.md](SETUP.md).
**Trying it first:** open the app with `?demo` for sample data.

## How it fits together

```
 phones (web/)  ──sign-in──▶  Supabase database  ◀── security rules: only allowed emails
      │                           │   ▲
      │ Ask, Find events          │   │ trigger on every change
      ▼                           ▼   │
 server functions (supabase/functions/)
   agent ......... Claude answers and edits; deletes and changes wait for a tap
   intake ........ pasted text, photos, PDFs, calendar files → Inbox
   inbound-email . forwarded emails → Inbox
   poll .......... hourly: school calendar feed and shared Google Docs → Inbox
   calendar-sync . events → shared Google Calendar
   notify ........ weekly summary, evening reminder, "things are waiting"
```

- `web/` — the phone app: plain HTML, CSS and JavaScript, installable, no build step.
- `supabase/migrations/` — tables, security rules and the operations that must be all-or-nothing.
- `supabase/functions/_shared/` — the logic, written so it can be tested without a network.
- `supabase/setup/` — SQL you run once (scheduled jobs; household template).
- `scripts/sheet_to_sql.py` — one-time move from the old Google Sheet.
- `tests/` — unit tests for the logic and database tests for the security rules: `npm test`.

Anything read from email, photos, documents or feeds only ever goes to the Inbox. Only a person
approves it onto the calendar.


## Setting it up for other families

See `onboarding/CHECKLIST.md`: an intake form, `scripts/new_family.py` (turns a family's answers into their setup files), and one-push updates to every family's copy (`deploy/families.json`).
