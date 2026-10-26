import datetime as dt

import pytest

from pico.checkins import next_run, normalize_schedule

TZ = dt.timezone(dt.timedelta(hours=-5))


def at(y, m, d, hh, mm):
    return dt.datetime(y, m, d, hh, mm, tzinfo=TZ)


def test_normalize():
    assert normalize_schedule({"time": "7:05"}) == {"time": "07:05", "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]}
    assert normalize_schedule({"time": "18:00", "days": "Fri,mon"})["days"] == ["mon", "fri"]
    assert normalize_schedule({"time": "18:00", "days": ["weekends"]})["days"] == ["sat", "sun"]
    for bad in ({"time": "24:00"}, {"time": "7"}, {"time": "07:00", "days": ["funday"]}, "x"):
        with pytest.raises(ValueError):
            normalize_schedule(bad)  # type: ignore[arg-type]


def test_next_run_same_day_and_rollover():
    # 2026-10-25 is a Sunday
    sched = {"time": "07:30", "days": ["mon", "wed"]}
    assert next_run(sched, at(2026, 10, 25, 12, 0)) == at(2026, 10, 26, 7, 30)  # -> Monday
    assert next_run(sched, at(2026, 10, 26, 7, 0)) == at(2026, 10, 26, 7, 30)   # later today
    assert next_run(sched, at(2026, 10, 26, 7, 30)) == at(2026, 10, 28, 7, 30)  # strictly after
    daily = {"time": "00:00"}
    assert next_run(daily, at(2026, 10, 31, 23, 59)) == at(2026, 11, 1, 0, 0)
    weekly = {"time": "09:00", "days": ["sun"]}
    assert next_run(weekly, at(2026, 10, 25, 9, 0)) == at(2026, 11, 1, 9, 0)


def test_effort_mapping():
    from pico.agent_bridge import effort_params
    rc, ro = effort_params("off", "custom")  # internal-only (compaction); users' "off" is normalized to low first
    assert rc == {"enabled": False} and ro["extra_body"]["chat_template_kwargs"]["enable_thinking"] is False
    rc, ro = effort_params("medium", "custom")
    assert rc == {"enabled": True, "effort": "medium"}
    rc, ro = effort_params("high", "openai_login")
    assert rc["effort"] == "high" and ro == {}
    assert effort_params("bogus", "custom")[0]["effort"] == "medium"
