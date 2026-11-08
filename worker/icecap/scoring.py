"""Configurable 0–100 lead score. A score ranks research priority; it is NOT evidence of a financing need."""
from __future__ import annotations

from datetime import date
from typing import Any

from .stages import rank


def _unit_fit(units: int | None) -> tuple[float, str]:
    if units is None:
        return 0.3, "unit count unknown"
    if units < 1 or units > 200:
        return 0.0, f"{units} units outside 1–200"
    if 5 <= units <= 100:
        return 1.0, f"{units} units — core fit"
    if 101 <= units <= 200:
        return 0.8, f"{units} units — upper range"
    if 2 <= units <= 4:
        return 0.8, f"{units} units — small multifamily"
    return 0.6, "single unit"


def _stage(stage: str | None) -> tuple[float, str]:
    r = rank(stage)
    if r is None:
        return 0.4, "stage unknown"
    if r <= 25:
        return 1.0, "early: planning / zoning"
    if r <= 40:
        return 0.8, "approvals / permit application"
    if r <= 50:
        return 0.5, "permit issued — financing may be arranged"
    if r <= 60:
        return 0.25, "under construction"
    return 0.1, "complete / inactive"


def _loan(fit: str | None, loan_high: float | None) -> tuple[float, str]:
    if fit == "likely":
        if loan_high is not None and loan_high < 1_000_000:
            return 0.5, "likely fit but small estimated loan"
        return 1.0, "estimated loan within cap"
    if fit == "outside_scope":
        return 0.0, "estimated loan above cap"
    return 0.4, "loan size uncertain"


def _newness(latest: date | None, today: date) -> tuple[float, str]:
    if latest is None:
        return 0.2, "no filing date"
    d = (today - latest).days
    if d <= 7:
        return 1.0, f"filed {d}d ago"
    if d <= 30:
        return 0.8, f"filed {d}d ago"
    if d <= 90:
        return 0.5, f"filed {d}d ago"
    if d <= 180:
        return 0.3, f"filed {d}d ago"
    return 0.1, f"filed {d}d ago"


def _contact(has_verified_contact: bool, has_named_developer: bool, has_applicant: bool) -> tuple[float, str]:
    if has_verified_contact:
        return 1.0, "public business contact with source"
    if has_named_developer:
        return 0.5, "developer/proponent named, no contact"
    if has_applicant:
        return 0.3, "applicant/agent named only"
    return 0.0, "no named party"


def _activity(n_other_projects: int | None) -> tuple[float, str]:
    if n_other_projects is None:
        return 0.0, "developer unknown"
    if n_other_projects >= 2:
        return 1.0, f"{n_other_projects} other projects"
    if n_other_projects == 1:
        return 0.6, "1 other project"
    return 0.2, "no other projects on record"


def score(p: dict[str, Any], settings: dict, today: date) -> tuple[int, dict]:
    w = settings["scoring"]["weights"]
    parts = {
        "unit_fit": _unit_fit(p.get("units_proposed")),
        "early_stage": _stage(p.get("stage")),
        "loan_size": _loan(p.get("financing_fit"), p.get("est_loan_high")),
        "newness": _newness(p.get("latest_filing_date"), today),
        "contact_quality": _contact(p.get("has_verified_contact", False), p.get("has_named_developer", False),
                                    p.get("has_applicant", False)),
        "developer_activity": _activity(p.get("developer_other_projects")),
    }
    total_w = sum(w.values()) or 1
    total = sum(parts[k][0] * w.get(k, 0) for k in parts) / total_w * 100
    breakdown = {k: {"weight": w.get(k, 0), "value": round(v, 2), "points": round(v * w.get(k, 0) * 100 / total_w, 1),
                     "why": why} for k, (v, why) in parts.items()}
    return int(round(total)), breakdown
