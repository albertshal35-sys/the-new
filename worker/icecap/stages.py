"""Normalized project stages, ordered by position in the development / financing cycle."""
from __future__ import annotations

STAGES: dict[str, tuple[int, str]] = {
    "denied_or_withdrawn": (5, "Denied / withdrawn"),
    "letter_of_intent": (10, "Letter of Intent (planning)"),
    "planning_filing": (15, "Planning filing submitted"),
    "under_review": (20, "Under Article 80 review"),
    "zoning_appeal": (25, "Zoning appeal filed"),
    "permit_application": (30, "Building permit application filed"),
    "zoning_approved": (35, "Zoning relief approved"),
    "board_approved": (40, "Planning board approved"),
    "permit_issued": (50, "Building permit issued"),
    "under_construction": (60, "Under construction"),
    "complete": (70, "Construction complete"),
}


def rank(stage: str | None) -> int | None:
    return STAGES[stage][0] if stage in STAGES else None


def label(stage: str | None) -> str:
    return STAGES[stage][1] if stage in STAGES else "Unknown"


A80_STATUS_TO_STAGE = {
    "letter of intent": "letter_of_intent",
    "under review": "under_review",
    "board approved": "board_approved",
    "permitted / under construction": "under_construction",
    "construction complete": "complete",
}
