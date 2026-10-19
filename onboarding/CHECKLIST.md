# Setting up families (pilot)

Each family gets their own copy: their own Supabase project (database + server), their own Netlify
site (the app), the same code. Pushing to `main` updates every copy.

## Once, before the first family

- [ ] **Supabase Pro** on your organization (the free plan allows only 2 projects).
- [ ] **A domain for email** (e.g. from Cloudflare or Namecheap, about $15 a year). In Brevo, add it under
      Senders, domains & dedicated IPs and verify it, then send from e.g. `hello@<domain>`. Use one Brevo API key for all families.
- [ ] **Google**: keep using your existing service account; each family's calendar is shared with it.
- [ ] **GitHub**: the repo secret `SUPABASE_ACCESS_TOKEN` already covers every project in your Supabase organization.
- [ ] **Agreement**: a one-page note families accept: what's stored (names, calendars, emails they forward),
      who can see it (you, for support), how to leave (you delete their project), and the price.

## For each family (about an hour once you've done one)

1. Send them `onboarding/INTAKE.md` (or go through it on a call).
2. Copy `onboarding/family.example.json` to `onboarding/<their-name>.json` and fill in their answers.
   Custody patterns: `/@ ?Jess/` matches "Kids @Jess's" or "Kids @ Jess"; plain text matches anywhere, any case.
3. Run `python3 scripts/new_family.py onboarding/<their-name>.json`.
   It checks the answers and writes `onboarding/out/<their-name>/setup.sql`, `cron.sql` and `CHECKLIST.md`.
4. Follow their `CHECKLIST.md` top to bottom (Supabase → GitHub environment → setup.sql → secrets → Netlify → Google → checks).
   After creating their Supabase project, put its ref in the JSON as `supabase_ref` and run step 3 again so `cron.sql` is filled in.
5. Setup day with them: install on each phone, notifications on, optional Siri shortcut.
6. First week: watch their Inbox for noise and tighten `include` / `exclude` on their school calendar.

The files in `onboarding/out/` and the filled-in JSON hold a family's emails and calendar links:
they are ignored by git on purpose. Keep them on your computer, not in the repo.

## Updating everyone

Push to `main`. GitHub Actions runs the tests, then updates your copy and every family listed in
`deploy/families.json`. Netlify republishes each family's app from the same commit.

## Taking a family off

Remove them from `deploy/families.json`, delete their GitHub environment, Netlify site and Supabase
project, and revoke their Claude API key.
