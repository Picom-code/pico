"""Schedules for check-ins / crons: four input shapes, one canonical dict, deterministic next-run.

Accepted (POST /api/checkins `schedule`, `/cron add`):
  {time:"07:30", days:[...]}        weekly clock time (legacy check-ins; empty days = every day)
  {every:"30m"|"2h"|"1d"}            fixed interval (min 1 minute), anchored on the last run
  {cron:"0 8 * * 1-5"}               5-field cron (minute hour day-of-month month day-of-week), local time
  {text:"every weekday at 8am"}      natural language -> one of the above (deterministic parser below;
                                     the server may fall back to asking the model for a cron line)

Canonical forms keep the input keys and add helpers: every -> {every, every_s}; text -> parsed form +
{text}. `describe()` gives the human `schedule_text`.
"""
from __future__ import annotations

import datetime as dt
import re
from typing import Optional

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DAY_NAMES = {"mon": "Mon", "tue": "Tue", "wed": "Wed", "thu": "Thu", "fri": "Fri", "sat": "Sat", "sun": "Sun"}
_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
MIN_EVERY_S = 60


# ── weekly clock schedule (legacy) ─────────────────────────────────────────────

def _norm_days(days_in) -> list[str]:
    days_in = days_in or DAYS
    if isinstance(days_in, str):
        days_in = [d.strip() for d in re.split(r"[,\s]+", days_in) if d.strip()]
    aliases = {"weekdays": DAYS[:5], "weekday": DAYS[:5], "weekends": DAYS[5:], "weekend": DAYS[5:],
               "daily": DAYS, "everyday": DAYS, "day": DAYS, "days": DAYS}
    days: list[str] = []
    for d in days_in:
        d = str(d).strip().lower()
        for x in aliases.get(d, [d[:3]]):
            if x not in DAYS:
                raise ValueError(f"unknown day {d!r}")
            if x not in days:
                days.append(x)
    days.sort(key=DAYS.index)
    return days


def normalize_weekly(schedule: dict) -> dict:
    t = str(schedule.get("time", "")).strip()
    m = _TIME_RE.match(t)
    if not m:
        raise ValueError("schedule.time must be HH:MM (24h)")
    return {"time": f"{int(m.group(1)):02d}:{m.group(2)}", "days": _norm_days(schedule.get("days"))}


def _next_weekly(s: dict, after: dt.datetime) -> dt.datetime:
    hh, mm = map(int, s["time"].split(":"))
    for i in range(0, 8):
        day = after.date() + dt.timedelta(days=i)
        if DAYS[day.weekday()] not in s["days"]:
            continue
        cand = dt.datetime.combine(day, dt.time(hh, mm), tzinfo=after.tzinfo)
        if cand > after:
            return cand
    raise ValueError("schedule has no days")


# ── intervals ────────────────────────────────────────────────────────────────

_EVERY_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|"
                       r"d|day|days|w|wk|week|weeks)\s*$", re.I)
_UNIT_S = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


def parse_interval(text: str) -> Optional[int]:
    """'30m' / '2 hours' / '1d' / '45s' -> seconds (None if it isn't an interval)."""
    m = _EVERY_RE.match(str(text or ""))
    if not m:
        return None
    unit = m.group(2).lower()
    unit = "m" if unit.startswith("mi") or unit == "m" else unit[0]
    return int(float(m.group(1)) * _UNIT_S[unit])


def fmt_interval(s: int) -> str:
    for u, n in (("w", 604800), ("d", 86400), ("h", 3600), ("m", 60)):
        if s % n == 0 and s >= n:
            return f"{s // n}{u}"
    return f"{s}s"


# ── cron ─────────────────────────────────────────────────────────────────────

_CRON_FIELDS = (("minute", 0, 59), ("hour", 0, 23), ("day of month", 1, 31), ("month", 1, 12), ("day of week", 0, 7))
_CRON_NAMES = {3: {n: i + 1 for i, n in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())},
               4: {n: (i + 1) % 7 for i, n in enumerate(DAYS)}}


def _cron_field(spec: str, idx: int) -> set[int]:
    name, lo, hi = _CRON_FIELDS[idx]
    out: set[int] = set()
    for part in spec.lower().split(","):
        step = 1
        if "/" in part:
            part, st = part.split("/", 1)
            if not st.isdigit() or int(st) < 1:
                raise ValueError(f"bad step in cron {name}")
            step = int(st)
        if part in ("*", ""):
            a, b = lo, hi
        else:
            def val(x: str) -> int:
                x = x.strip()
                if x in _CRON_NAMES.get(idx, {}):
                    return _CRON_NAMES[idx][x]
                if not x.isdigit():
                    raise ValueError(f"bad cron {name}: {x!r}")
                return int(x)
            if "-" in part:
                a, b = (val(x) for x in part.split("-", 1))
            else:
                a = b = val(part)
                if step > 1:
                    b = hi
        if not (lo <= a <= hi and lo <= b <= hi and a <= b):
            raise ValueError(f"cron {name} out of range")
        out.update(range(a, b + 1, step))
    if idx == 4 and 7 in out:
        out.discard(7)
        out.add(0)
    return out


def parse_cron(expr: str) -> list[set[int]]:
    parts = str(expr or "").split()
    if len(parts) != 5:
        raise ValueError("cron must have 5 fields: minute hour day-of-month month day-of-week")
    return [_cron_field(p, i) for i, p in enumerate(parts)]


def _next_cron(expr: str, after: dt.datetime) -> dt.datetime:
    mins, hours, doms, months, dows = parse_cron(expr)
    parts = expr.split()
    dom_any, dow_any = parts[2] == "*", parts[4] == "*"
    start = (after + dt.timedelta(minutes=1)).replace(second=0, microsecond=0)
    for i in range(0, 366 * 5):
        day = start.date() + dt.timedelta(days=i)
        if day.month not in months:
            continue
        dom_ok, dow_ok = day.day in doms, ((day.weekday() + 1) % 7) in dows
        # classic cron: when both are restricted, either may match
        if not ((dom_ok and dow_ok) if (dom_any or dow_any) else (dom_ok or dow_ok)):
            continue
        for h in sorted(hours):
            for m in sorted(mins):
                cand = dt.datetime.combine(day, dt.time(h, m), tzinfo=after.tzinfo)
                if cand >= start:
                    return cand
    raise ValueError("cron never fires")


def describe_cron(expr: str) -> str:
    p = expr.split()
    try:
        mins, hours, _, _, dows = parse_cron(expr)
    except ValueError:
        return f"cron {expr}"
    if p[2] == "*" and p[3] == "*" and len(mins) == 1 and len(hours) == 1:
        t = f"{next(iter(hours)):02d}:{next(iter(mins)):02d}"
        days = [DAYS[(d - 1) % 7] for d in sorted(dows, key=lambda d: (d - 1) % 7)]
        return f"{_days_text(days)} at {t}"
    if p[0].startswith("*/") and p[1:] == ["*"] * 4:
        return f"every {p[0][2:]}m"
    if p[0].isdigit() and p[1] == "*" and p[2:] == ["*"] * 3:
        return f"hourly at :{int(p[0]):02d}"
    return f"cron {expr}"


# ── natural language ───────────────────────────────────────────────────────────

_NUM_WORDS = {"one": 1, "a": 1, "an": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "ten": 10,
              "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30, "forty-five": 45, "half": 0.5}
_DAY_RE = r"(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|s|sday|nesday|urday|rsday)?s?"
_DAYS_PHRASE = (rf"(?:every\s+|on\s+|each\s+)?(?P<days>day|daily|weekday|weekdays|weekend|weekends|"
                rf"{_DAY_RE}(?:\s*(?:,|and|&|\+)\s*{_DAY_RE})*)")
_TIME_PHRASE = (r"(?:at\s+)?(?P<time>noon|midnight|morning|evening|night|"
                r"\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?|\d{1,2}:\d{2})")
_TOD = {"noon": "12:00", "midnight": "00:00", "morning": "08:00", "evening": "18:00", "night": "21:00"}


def _parse_clock(t: str) -> Optional[str]:
    t = t.strip().lower().replace(".", "")
    if t in _TOD:
        return _TOD[t]
    m = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", t)
    if not m:
        return None
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3)
    if ap:
        if not 1 <= h <= 12:
            return None
        h = (h % 12) + (12 if ap == "pm" else 0)
    elif m.group(2) is None and h <= 6:
        h += 12  # "at 5" with no am/pm: assume 5pm (nobody schedules a 5am check-in by accident)
    if not (0 <= h <= 23 and 0 <= mi <= 59):
        return None
    return f"{h:02d}:{mi:02d}"


def _days_from_phrase(d: str) -> list[str]:
    d = d.lower().strip()
    if d in ("day", "daily"):
        return list(DAYS)
    if d.startswith("weekday"):
        return DAYS[:5]
    if d.startswith("weekend"):
        return DAYS[5:]
    return _norm_days([x[:3] for x in re.split(r"\s*(?:,|and|&|\+)\s*", d) if x])


def parse_text(text: str) -> Optional[dict]:
    """Deterministic parse of common phrases -> canonical schedule (without `text`), or None.

    Whole-string match only, so it can also be used to find where a schedule ends inside `/cron` args.
    """
    s = re.sub(r"\s+", " ", str(text or "").strip().lower()).rstrip(".")
    if not s:
        return None
    # cron line typed directly
    if re.fullmatch(r"[\d*/,\-a-z]+( [\d*/,\-a-z]+){4}", s) and not re.search(r"[a-z]{4,}", s):
        try:
            parse_cron(s)
            return {"cron": s}
        except ValueError:
            pass
    # hourly / daily shorthands
    if s in ("hourly", "every hour", "each hour", "once an hour"):
        return {"every": "1h", "every_s": 3600}
    if s in ("every minute",):
        return {"every": "1m", "every_s": 60}
    # every N units / every half hour / every other hour
    m = re.fullmatch(r"(?:every|each) (?P<n>[\w.-]+)? ?(?P<u>seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)", s)
    if m:
        n = m.group("n")
        if n is None:
            n_v: float = 1
        elif n.replace(".", "", 1).isdigit():
            n_v = float(n)
        elif n in _NUM_WORDS:
            n_v = _NUM_WORDS[n]
        elif n == "other":
            n_v = 2
        else:
            n_v = -1
        if n_v > 0:
            u = m.group("u")
            if u.startswith("d") and n is None:
                pass  # "every day" -> daily clock below
            else:
                secs = parse_interval(f"{n_v:g}{u}")
                if secs:
                    return {"every": fmt_interval(secs), "every_s": secs}
    m = re.fullmatch(r"every half(?: an)? hour", s)
    if m:
        return {"every": "30m", "every_s": 1800}
    m = re.fullmatch(r"(?:every )?(\d+(?:\.\d+)?\s*(?:s|m|h|d|w))", s)
    if m:
        secs = parse_interval(m.group(1))
        if secs:
            return {"every": fmt_interval(secs), "every_s": secs}
    # "[every] <days> [at] <time>" | "<time> <days>" | "daily at 8" | "every morning" | "weekdays"
    for pat in (rf"{_DAYS_PHRASE}(?: at| @)? ?{_TIME_PHRASE}?", rf"{_TIME_PHRASE},? (?:on )?{_DAYS_PHRASE}",
                rf"(?:every |each )?{_TIME_PHRASE}"):
        m = re.fullmatch(pat, s)
        if not m:
            continue
        gd = m.groupdict()
        t = gd.get("time")
        days = _days_from_phrase(gd["days"]) if gd.get("days") else list(DAYS)
        if t is None and not gd.get("days"):
            continue
        if pat.endswith(f"{_TIME_PHRASE}") and not gd.get("days") and t not in _TOD and not s.startswith(("every", "each")):
            # bare "8am" is fine; bare number like "5" is too ambiguous
            if not re.search(r"am|pm|:", t or ""):
                continue
        clock = _parse_clock(t) if t else "09:00"
        if not clock:
            continue
        return {"time": clock, "days": days}
    return None


# ── public API ────────────────────────────────────────────────────────────────

def normalize(schedule) -> dict:
    """Any accepted input shape -> canonical dict. Raises ValueError with a plain message."""
    if isinstance(schedule, str):
        schedule = {"text": schedule}
    if not isinstance(schedule, dict):
        raise ValueError("schedule must be an object: {time,days} | {every} | {cron} | {text}")
    if schedule.get("every") not in (None, ""):
        ev = schedule["every"]
        secs = int(ev) if isinstance(ev, (int, float)) else parse_interval(str(ev))
        if not secs:
            raise ValueError("schedule.every must look like 30m, 2h or 1d")
        if secs < MIN_EVERY_S:
            raise ValueError("schedule.every must be at least 1m")
        out = {"every": fmt_interval(secs), "every_s": secs}
    elif schedule.get("cron"):
        expr = " ".join(str(schedule["cron"]).split())
        parse_cron(expr)
        _next_cron(expr, dt.datetime.now().astimezone())  # never-firing crons (Feb 30) are errors
        out = {"cron": expr}
    elif schedule.get("time") not in (None, ""):
        out = normalize_weekly(schedule)
    elif schedule.get("text"):
        parsed = parse_text(schedule["text"])
        if not parsed:
            raise ValueError(f"couldn't understand the schedule {schedule['text']!r} — try 'every weekday at 8am', "
                             "'every 30m' or a cron line like '0 8 * * 1-5'")
        out = normalize(parsed)
    else:
        raise ValueError("schedule needs time, every, cron or text")
    if schedule.get("text"):
        out["text"] = str(schedule["text"]).strip()
    return out


def next_run(schedule: dict, after: Optional[dt.datetime] = None, last_run: Optional[float] = None) -> dt.datetime:
    """Next local datetime strictly after `after`. Intervals anchor on `last_run` when given."""
    s = schedule if ("every_s" in schedule or "cron" in schedule or "days" in schedule) else normalize(schedule)
    after = after or dt.datetime.now().astimezone()
    if after.tzinfo is None:
        after = after.astimezone()
    if "every_s" in s:
        step = dt.timedelta(seconds=int(s["every_s"]))
        if last_run:
            cand = dt.datetime.fromtimestamp(last_run, after.tzinfo) + step
            return cand if cand > after else after + step
        return after + step
    if "cron" in s:
        return _next_cron(s["cron"], after)
    return _next_weekly(normalize_weekly(s), after)


def _days_text(days: list[str]) -> str:
    if days == DAYS:
        return "every day"
    if days == DAYS[:5]:
        return "every weekday"
    if days == DAYS[5:]:
        return "weekends"
    return "every " + ", ".join(DAY_NAMES[d] for d in days)


def describe(schedule: dict) -> str:
    """Human text for a canonical schedule ('every weekday at 08:00', 'every 30m', …)."""
    try:
        if "every_s" in schedule:
            return f"every {fmt_interval(int(schedule['every_s']))}"
        if "cron" in schedule:
            return describe_cron(schedule["cron"])
        s = normalize_weekly(schedule)
        return f"{_days_text(s['days'])} at {s['time']}"
    except (ValueError, KeyError, TypeError):
        return str(schedule)


CRON_FALLBACK_PROMPT = ("Convert the schedule description to ONE standard 5-field cron line (minute hour day-of-month "
                        "month day-of-week), local time. Reply with the cron line only, nothing else. If standard "
                        "cron can't express it exactly (e.g. 'first Monday of the month', 'every other Tuesday', "
                        "'last day of the month'), reply NONE.")

# phrases standard cron can't express exactly; the model tends to approximate them (first Monday -> every Monday)
_INEXPRESSIBLE = re.compile(r"\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|every other|alternate|"
                            r"biweekly|fortnight\w*)\b.*\b(mon|tue|wed|thu|fri|sat|sun|week|day of)", re.I)


def cron_expressible(text: str) -> bool:
    return not _INEXPRESSIBLE.search(text or "")
