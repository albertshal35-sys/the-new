"""Configurable business settings: defaults merged with overrides stored in the `settings` table."""
from __future__ import annotations

import copy
from typing import Any

DEFAULTS: dict[str, Any] = {
    "business": {
        "min_units": 1,
        "max_units": 200,
        "max_loan": 50_000_000,
    },
    "alerts": {
        # Default: notify on every verified new qualifying development filing.
        "notify_qualified": True,
        "notify_needs_review": False,
        "min_score": 0,
        "min_units": None,
        "event_types": ["new_project", "units_changed", "new_plan_submission", "approval", "permit_issued"],
        "quiet_hours": None,           # e.g. {"start": "22:00", "end": "07:00", "tz": "America/New_York"}
        "daily_digest": True,
        "digest_hour_local": 8,
        "weekly_report": True,
        "weekly_report_weekday": 0,    # Monday
        "timezone": "America/New_York",
    },
    "scoring": {
        "weights": {
            "unit_fit": 25,
            "early_stage": 20,
            "loan_size": 15,
            "newness": 15,
            "contact_quality": 15,
            "developer_activity": 10,
        },
    },
    "financing": {
        # Total development cost per unit (USD) — ASSUMPTIONS for Boston, editable in Settings.
        "tdc_per_unit": {
            "new_construction": {"single_family": [550_000, 1_000_000], "two_to_four_family": [450_000, 750_000],
                                 "multifamily": [450_000, 750_000]},
            "substantial_rehab": [200_000, 400_000],
            "conversion": [250_000, 450_000],
            "addition": [150_000, 350_000],
        },
        "hard_cost_to_tdc": [1.25, 1.60],   # declared construction valuation → total development cost
        "official_cost_band": [0.90, 1.15], # tolerance around an officially stated project cost
        "loan_to_cost": [0.60, 0.75],
        "bridge_loan_to_cost": [0.50, 0.70],
    },
}


def deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


async def load_settings(db) -> dict:
    rows = await db.fetch("SELECT key, value FROM settings")
    merged = copy.deepcopy(DEFAULTS)
    for r in rows:
        if r["key"] in merged and isinstance(r["value"], dict):
            merged[r["key"]] = deep_merge(merged[r["key"]], r["value"])
        else:
            merged[r["key"]] = r["value"]
    return merged
