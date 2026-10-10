#!/usr/bin/env python3
"""
One-time move from the old Google Sheet to Supabase.

    python3 scripts/sheet_to_sql.py "Household Manager.xlsx" > import.local.sql

Download the Sheet with File → Download → Microsoft Excel (.xlsx), run this, then
paste the output into Supabase → SQL Editor and run it. Safe to run twice: rows
that already exist are skipped. The output contains your family's data, so keep
it out of the repository (*.local.sql is ignored by git).

Needs: openpyxl (pip install openpyxl)
"""
import datetime as dt
import sys

import openpyxl


def q(v):
    """A SQL string literal."""
    return "'" + str(v).replace("'", "''") + "'"


def text(v):
    return "" if v is None else str(v).strip()


def date_of(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime("%Y-%m-%d")
    s = text(v)[:10]
    try:
        dt.date.fromisoformat(s)
        return s
    except ValueError:
        return ""


def time_of(v):
    if isinstance(v, dt.datetime):
        return v.strftime("%H:%M")
    if isinstance(v, dt.time):
        return v.strftime("%H:%M")
    s = text(v)
    if ":" in s:
        h, m = s.split(":")[:2]
        if h.isdigit() and m[:2].isdigit() and int(h) < 24:
            return f"{int(h):02d}:{m[:2]}"
    return ""


def arr(v):
    ids = [x.strip() for x in text(v).split(",") if x.strip() and x.strip() != "none"]
    return "array[" + ",".join(q(i) for i in ids) + "]::text[]" if ids else "'{}'::text[]"


def ts(v):
    if isinstance(v, dt.datetime):
        return q(v.isoformat())
    s = text(v)
    try:
        dt.datetime.fromisoformat(s.replace(" ", "T") if len(s) > 10 else s)
        return q(s)
    except ValueError:
        return "now()"


def rows(ws):
    data = [r for r in ws.iter_rows(values_only=True) if any(c not in (None, "") for c in r)]
    if not data:
        return []
    head = [text(h) for h in data[0]]
    return [dict(zip(head, r)) for r in data[1:]]


def main(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    out = ["-- Household Manager: data moved from the old Google Sheet.", "begin;", ""]
    today = dt.date.today().isoformat()

    out.append("-- People")
    for i, m in enumerate(rows(wb["Members"])):
        kind = text(m.get("kind")) if text(m.get("kind")) in ("adult", "kid", "other") else "kid"
        active = "false" if text(m.get("active")).upper() == "FALSE" else "true"
        out.append(
            "insert into public.members (id, name, kind, color, active, sort) values "
            f"({q(text(m['id']))}, {q(text(m['name']))}, {q(kind)}, {q(text(m.get('color')) or '#5C6763')}, {active}, {i}) "
            "on conflict (id) do nothing;"
        )

    out.append("\n-- Calendar")
    skipped = 0
    for e in rows(wb["Events"]):
        d = date_of(e.get("date"))
        if not text(e.get("id")) or not text(e.get("title")) or not d:
            skipped += 1
            continue
        t = time_of(e.get("time"))
        drv = text(e.get("driver"))
        out.append(
            "insert into public.events (id, title, date, time, for_ids, driver, with_us, place, note, source, created_by, created_at) values ("
            f"{q(text(e['id']))}, {q(text(e['title']))}, {q(d)}, {q(t) if t else 'null'}, {arr(e.get('for'))}, "
            f"{q(drv) if drv else 'null'}, {arr(e.get('withUs'))}, {q(text(e.get('where')))}, {q(text(e.get('note')))}, "
            f"{q(text(e.get('source')) or 'manual')}, {q(text(e.get('createdBy')))}, {ts(e.get('createdAt'))}) on conflict (id) do nothing;"
        )

    if "Ideas" in wb.sheetnames:
        out.append("\n-- Shelf")
        for it in rows(wb["Ideas"]):
            if not text(it.get("title")):
                continue
            d, t = date_of(it.get("date")), time_of(it.get("time"))
            out.append(
                "insert into public.ideas (id, title, date, time, for_ids, cost, link, note) values ("
                f"{q(text(it.get('id')) or 'i' + str(abs(hash(text(it['title']))))[:7])}, {q(text(it['title']))}, "
                f"{q(d) if d else 'null'}, {q(t) if t else 'null'}, {arr(it.get('for'))}, {q(text(it.get('cost')))}, "
                f"{q(text(it.get('link')))}, {q(text(it.get('note')))}) on conflict (id) do nothing;"
            )

    out.append("\n-- Waiting for approval (past dates and repeats are left behind)")
    for p in rows(wb["Pending"]):
        d = date_of(p.get("date"))
        if not text(p.get("title")) or not d or d < today:
            continue
        t = time_of(p.get("time"))
        conf = "low" if text(p.get("confidence")) == "low" else "high"
        out.append(
            "insert into public.pending (id, title, date, time, for_ids, place, note, source, source_ref, confidence) values ("
            f"{q(text(p.get('id')))}, {q(text(p['title']))}, {q(d)}, {q(t) if t else 'null'}, {arr(p.get('for'))}, "
            f"{q(text(p.get('where')))}, {q(text(p.get('note')))}, {q(text(p.get('source')) or 'text')}, "
            f"{q(text(p.get('sourceRef')))}, {q(conf)}) on conflict do nothing;"
        )

    out += ["", "commit;", f"-- {skipped} calendar rows without an id, title or date were skipped."]
    print("\n".join(out))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
