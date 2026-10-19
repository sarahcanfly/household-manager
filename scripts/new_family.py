#!/usr/bin/env python3
"""Turn a family's intake answers into their setup files.

    python3 scripts/new_family.py onboarding/smith.json

Writes onboarding/out/<slug>/:
  setup.sql      who can sign in, people, settings, feeds, reminders (run once in their SQL Editor)
  cron.sql       the hourly jobs, with their project ref filled in (run once, after secrets)
  CHECKLIST.md   every step for this family, in order, with their details filled in
Nothing here touches any database; it only writes files. No packages needed.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PALETTE = ["#3F6B54", "#8E4767", "#3B5A8A", "#A8752A", "#2E6E75", "#9A4B2E", "#4C5B3F", "#7A4E7E"]
DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
KINDS = {"adult", "kid", "other"}


class Bad(Exception):
    pass


def sql_str(v: str) -> str:
    return "'" + str(v).replace("'", "''") + "'"


def sql_json(v) -> str:
    return sql_str(json.dumps(v, ensure_ascii=False)) + "::jsonb"


def check_url(u: str, what: str) -> str:
    u = (u or "").strip()
    if not re.match(r"^(https|webcal)://\S+$", u, re.I):
        raise Bad(f"{what}: the link must start with https:// or webcal:// (got {u!r})")
    return u


def check_pattern(p: str, what: str) -> str:
    p = str(p)
    m = re.match(r"^/(.+)/$", p)
    if m:
        try:
            re.compile(m.group(1))
        except re.error as e:
            raise Bad(f"{what}: {p!r} is not a valid pattern ({e})")
    return p


def build(fam: dict):
    slug = str(fam.get("slug", "")).strip().lower()
    if not re.match(r"^[a-z0-9][a-z0-9-]{1,30}$", slug):
        raise Bad("slug: short lowercase name like 'smith' (letters, numbers, dashes)")

    people = fam.get("people") or []
    if not people:
        raise Bad("people: list everyone in the household")
    names = {}
    for p in people:
        n = str(p.get("name", "")).strip()
        k = p.get("kind")
        if not n or k not in KINDS:
            raise Bad(f"people: each needs a name and a kind (adult, kid or other): {p}")
        if n.lower() in names:
            raise Bad(f"people: {n} is listed twice")
        names[n.lower()] = p
    adults = [p for p in people if p["kind"] == "adult"]
    logins = [str(p["email"]).strip().lower() for p in adults if p.get("email")]
    if not logins:
        raise Bad("people: at least one adult needs an email to sign in")
    for e in logins:
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", e):
            raise Bad(f"people: {e!r} is not an email address")
    emails = [str(p["email"]).strip().lower() for p in adults if p.get("email") and p.get("gets_emails", True)]

    def known(who, what):
        for n in who:
            if str(n).lower() not in names:
                raise Bad(f"{what}: {n!r} is not one of the people")
        return [names[str(n).lower()]["name"] for n in who]

    feeds = []
    for f in fam.get("school_calendars") or []:
        name = str(f.get("name", "")).strip() or "School"
        feed = {"name": name, "url": check_url(f.get("url"), f"school calendar {name}")}
        if f.get("include"):
            feed["include"] = [check_pattern(x, f"{name} include") for x in f["include"]]
        if f.get("exclude"):
            feed["exclude"] = [check_pattern(x, f"{name} exclude") for x in f["exclude"]]
        if f.get("for"):
            feed["tag"] = [{"match": "/./", "who": known(f["for"], f"{name} for")}]
        feeds.append(feed)
    for c in fam.get("coparent_calendars") or []:
        name = str(c.get("name", "")).strip() or "Co-parent"
        kids = known(c.get("kids") or [], f"{name} kids")
        if not kids:
            raise Bad(f"{name}: list the kids this calendar is about")
        for k in ("home_match", "away_match", "home_label", "away_label"):
            if not str(c.get(k, "")).strip():
                raise Bad(f"{name}: {k} is missing (see the example)")
        feeds.append({
            "name": name, "url": check_url(c.get("url"), f"co-parent calendar {name}"), "mode": "sync",
            "default_for": kids, "horizon_days": 120,
            "custody": [
                {"match": check_pattern(c["away_match"], f"{name} away_match"), "with_us": [], "where": c["away_label"]},
                {"match": check_pattern(c["home_match"], f"{name} home_match"), "with_us": kids, "where": c["home_label"]},
            ],
        })

    weekly = fam.get("weekly") or {}
    wday = str(weekly.get("day", "MONDAY")).upper()
    if wday not in DAYS:
        raise Bad(f"weekly.day: one of {', '.join(DAYS)}")
    hour = lambda v, d: int(v) if v is not None and 0 <= int(v) <= 23 else d
    region = str(fam.get("holiday_region", "US")).upper()
    if region not in {"MA", "US", "NONE"}:
        raise Bad("holiday_region: MA (adds Patriots' Day), US, or NONE")
    town = str(fam.get("town", "")).strip()
    if not town:
        raise Bad("town: e.g. 'Natick, MA' (used for local events)")

    settings = {
        "notify": emails,
        "timezone": fam.get("timezone") or "America/New_York",
        "weekly": {"enabled": True, "day": wday, "hour": hour(weekly.get("hour"), 7)},
        "reminders": {"enabled": True, "hour": hour(fam.get("evening_reminder_hour"), 18)},
        "digest": {"enabled": True, "hour": 19},
        "morning": {"enabled": fam.get("morning_hour") is not None, "hour": hour(fam.get("morning_hour"), 7), "email": False},
        "feeds": feeds,
        "holiday_region": region,
        "local_events": {"enabled": True, "area": town, "radius_miles": 15,
                         "interests": fam.get("interests") or "kid-friendly and family outings, plus a few things for adults",
                         "max": 6, "music": bool(fam.get("live_music", True)), "music_max": 3},
    }

    reminders = []
    for r in fam.get("reminders") or []:
        days = [DAYS.index(str(d).upper()) for d in r.get("days", []) if str(d).upper() in DAYS]
        if not r.get("title") or not days:
            raise Bad(f"reminders: each needs a title and days: {r}")
        if r.get("holiday", "none") not in {"none", "skip", "shift"}:
            raise Bad("reminders: holiday is none, skip or shift")
        reminders.append({"title": r["title"], "note": r.get("note", ""), "days": sorted(set(days)),
                          "hour": hour(r.get("hour"), 7), "holiday": r.get("holiday", "none")})

    lines = [
        f"-- Setup for the {slug} household. Generated by scripts/new_family.py; run once in their Supabase SQL Editor.",
        "-- Safe to run again: it replaces their settings and people with what is below.",
        "begin;",
        "",
        "insert into public.allowed_users (email) values",
        ",\n".join(f"  ({sql_str(e)})" for e in logins) + "\non conflict (email) do nothing;",
        "",
        "-- People, in the order they appear in the app (colours follow this order).",
        "update public.members set active = false;",
    ]
    for i, p in enumerate(people):
        mid = f"{slug[:4]}{i + 1}"
        lines.append(
            f"insert into public.members (id, name, kind, color, active, sort) values ({sql_str(mid)}, {sql_str(p['name'].strip())}, "
            f"{sql_str(p['kind'])}, {sql_str(PALETTE[i % len(PALETTE)])}, true, {i}) "
            "on conflict (id) do update set name = excluded.name, kind = excluded.kind, color = excluded.color, active = true, sort = excluded.sort;")
    lines += ["", "insert into public.settings (key, value) values"]
    lines.append(",\n".join(f"  ({sql_str(k)}, {sql_json(v)})" for k, v in settings.items()))
    lines += ["on conflict (key) do update set value = excluded.value;", ""]
    if reminders:
        lines.append("delete from public.reminders;")
        for r in reminders:
            lines.append(
                "insert into public.reminders (title, note, days, hour, holiday, created_by) values "
                f"({sql_str(r['title'])}, {sql_str(r['note'])}, '{{{','.join(map(str, r['days']))}}}', {r['hour']}, {sql_str(r['holiday'])}, 'setup');")
        lines.append("")
    lines.append("commit;")
    return slug, "\n".join(lines) + "\n", logins, emails, feeds


def checklist(fam, slug, logins, emails, feeds, ref):
    co = [f for f in feeds if f.get("mode") == "sync"]
    school = [f for f in feeds if f.get("mode") != "sync"]
    url = f"https://{ref}.supabase.co" if ref else "https://<their-ref>.supabase.co"
    t = f"""# Setup checklist: {fam.get('household_name') or slug}

Generated by `scripts/new_family.py`. Do the steps in order; tick them off as you go.
Shared services (Google service account, email domain, GitHub token) are set up once for all families:
see `onboarding/CHECKLIST.md`.

## 1. Their database (Supabase)
- [ ] New project in your Supabase organization, named `household-{slug}`, region East US. Save the database password.
- [ ] Copy the project's **Reference ID**{f' (yours: `{ref}`)' if ref else ''} and **publishable key**.
- [ ] Authentication → Sign In / Providers → Email: **off** "Allow new users to sign up", **off** "Confirm email".
- [ ] Authentication → Users → Add user, Auto Confirm, one for each: {', '.join(logins)}.

## 2. Code and updates (GitHub)
- [ ] Repo **Settings → Environments → New environment** `{slug}`, with secrets `SUPABASE_PROJECT_REF` and `SUPABASE_DB_PASSWORD`.
- [ ] Add `"{slug}"` to `deploy/families.json`, commit. The deploy creates their tables and server functions.

## 3. Their household (SQL Editor)
- [ ] Run `onboarding/out/{slug}/setup.sql`: sign-ins, people, settings, {len(school)} school calendar(s), {len(co)} co-parent calendar(s), reminders.

## 4. Server secrets (Edge Functions → Secrets)
- [ ] `ANTHROPIC_API_KEY`: a new key just for this family (Claude Console → API keys), so you can see their costs.
- [ ] `APP_URL` and `APP_ORIGIN`: their Netlify address from step 5, e.g. `https://{slug}-household.netlify.app` (no slash at the end for APP_ORIGIN).
- [ ] `GOOGLE_SERVICE_ACCOUNT_JSON`: the shared service account's key file. `GOOGLE_CALENDAR_ID`: their Household calendar (step 6).
- [ ] `BREVO_API_KEY`, `MAIL_FROM` (your sending domain), `MAIL_FROM_NAME` = `{fam.get('household_name') or 'Household'}`.
- [ ] `INBOUND_SECRET`: a long random string (step 7 uses it).
- [ ] Run `onboarding/out/{slug}/cron.sql`, then add its last line's value as `CRON_SECRET`.

## 5. Their app (Netlify)
- [ ] Add new site → import `household-manager` from GitHub, site name `{slug}-household`.
- [ ] Site configuration → Environment variables: `HM_SUPABASE_URL` = `{url}`, `HM_SUPABASE_KEY` = their publishable key. Trigger a deploy.
- [ ] Make sure the site is **public** (not Netlify "Private"); the app's own sign-in protects it.

## 6. Google Calendar
- [ ] Create a calendar `{fam.get('household_name') or slug} household` (from your Google account), share it with the service account (**Make changes to events**) and with {', '.join(emails) or 'the adults'} (**See all event details**). Copy its Calendar ID into step 4.

## 7. Forwarded emails (optional)
- [ ] CloudMailin: new address, target `{url}/functions/v1/inbound-email?key=<INBOUND_SECRET>`, format **JSON (Normalized)**. Send them the address.

## 8. Check before handing over
- [ ] Open their app link, sign in as them, check Week (custody lines, school days), Inbox, Household.
- [ ] Household → **Check the school calendar now**; skim the Inbox and tighten include/exclude if noisy.
- [ ] Ask tab: "what's on this week?" and add/delete a test event.
- [ ] Household → **Email me this week's summary**.

## 9. Setup day with them (10–15 minutes)
- [ ] Each adult: open the link in Safari, sign in, **Share → Add to Home Screen**, open from the icon, **Household → Turn on notifications**.
- [ ] Accept the Google Calendar invite (optional). Siri shortcut (optional): SETUP.md step 9.
- [ ] Book the two-week check-in.
"""
    return t


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    src = Path(sys.argv[1])
    try:
        fam = json.loads(src.read_text())
        slug, setup_sql, logins, emails, feeds = build(fam)
    except (Bad, ValueError, KeyError) as e:
        print(f"Cannot build this family's setup: {e}", file=sys.stderr)
        sys.exit(1)
    ref = str(fam.get("supabase_ref") or "").strip()
    out = ROOT / "onboarding" / "out" / slug
    out.mkdir(parents=True, exist_ok=True)
    (out / "setup.sql").write_text(setup_sql)
    cron = (ROOT / "supabase" / "setup" / "cron.sql").read_text()
    (out / "cron.sql").write_text(cron.replace("YOUR-PROJECT-REF", ref) if ref else cron)
    (out / "CHECKLIST.md").write_text(checklist(fam, slug, logins, emails, feeds, ref))
    print(f"Wrote {out.relative_to(ROOT)}/setup.sql, cron.sql, CHECKLIST.md")
    if not ref:
        print("Add supabase_ref to the JSON once their project exists and run this again to fill in cron.sql.")


if __name__ == "__main__":
    main()
