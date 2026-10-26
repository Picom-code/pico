"""Slash-command parsing and prompt rewriting (engine-side; clients send plain text)."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

BUILTINS = ("goal", "plan", "compact", "undo", "lean", "yolo", "usage", "cron", "loop")
_SLASH = re.compile(r"^/([A-Za-z0-9][A-Za-z0-9_-]{0,63})!?(?:\s+(.*))?$", re.S)


@dataclass
class Slash:
    name: str
    arg: str

    @property
    def builtin(self) -> bool:
        return self.name in BUILTINS


def parse(text: str) -> Optional[Slash]:
    """`/goal ship it` → Slash('goal', 'ship it'). Paths like `/usr/bin` or `//x` are not commands."""
    t = (text or "").strip()
    m = _SLASH.match(t)
    if not m:
        return None
    name = m.group(1).lower()
    arg = (m.group(2) or "").strip()
    if "/" in name:
        return None
    return Slash(name, arg)


def plan_prompt(task: str) -> str:
    return ("[Plan mode] Make a short, concrete step-by-step plan for the task below. FIRST call the todo_list "
            "tool once with every step (status pending) — that is how the plan is shown to the user. You may read "
            "files or look around to plan well, but do not change anything or carry out the steps yet. Finish "
            "with a one-line summary and ask whether to proceed.\n\nTask: " + (task or "the current conversation's goal"))


def plan_execute_prompt(task: str) -> str:
    return ("[Plan then do] FIRST call the todo_list tool once with a short, concrete step-by-step plan for the task "
            "below (all pending) — that is how the plan is shown to the user. Then carry it out step by step, "
            "marking each item in_progress while you work on it and completed once verified (update todo_list as "
            "you go).\n\nTask: " + (task or "the current conversation's goal"))


PLAN_GO_PROMPT = ("Go ahead: carry out the plan now, step by step. Mark each todo_list item in_progress while you "
                  "work on it and completed once verified (update todo_list as you go).")


def skill_prompt(name: str, body: str, args: str, skill_dir: str = "") -> str:
    loc = f" Its files live in {skill_dir}." if skill_dir else ""
    head = (f'[The user invoked the "{name}" skill, so follow its instructions. The full skill is loaded '
            f"below.{loc}]")
    out = f"{head}\n\n<skill name=\"{name}\">\n{body.strip()}\n</skill>"
    if args:
        out += f"\n\nUser request: {args}"
    return out


COMPACT_PROMPT = ("Summarize our conversation so far so it can replace the full history. Keep: the user's goals "
                  "and preferences, decisions made, facts learned, file paths/commands that matter, open "
                  "questions and next steps. Be dense; use short bullet points. Reply with the summary only.")


def goal_context(goal: Optional[str]) -> str:
    if not goal:
        return ""
    return (f"Current goal for this chat (set by the user with /goal): {goal}\n"
            "Keep working toward it. Keep a todo_list of the steps toward the goal and update it as you go (it is "
            "shown to the user as progress). When the goal is fully met and verified, say so and end your reply "
            "with a line containing only GOAL_DONE.")
