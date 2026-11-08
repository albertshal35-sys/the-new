"""Business-filter classification: qualified / needs_review / rejected, with explicit reasons.

Rules (from IceCap's mandate):
* residential 1–200 proposed units inclusive; residential-led mixed use allowed
* development scopes only: ground-up, demolition/rebuild, conversion to residential, substantial rehab,
  additions creating units, significant redevelopment
* exclude commercial-only, hotel-only, institutional-only and ordinary maintenance / trade permits
* missing unit count -> needs_review (never silently discarded, never invented)
* estimated cost above the loan cap is NOT a rejection reason (handled by financing fit)
"""
from __future__ import annotations

from typing import Any, Iterable

from .models import NormalizedFiling

DEV_TYPES = {"new_construction", "demolition_rebuild", "conversion", "substantial_rehab", "addition", "adds_units"}
QUALIFIED, NEEDS_REVIEW, REJECTED = "qualified", "needs_review", "rejected"
# Proposed uses that can dominate a project. Institutional/industrial words are usually the EXISTING use being
# converted (church -> housing), so they only matter when no residential units are proposed.
STRONG_NONRES = {"hotel", "lab_office"}
RESIDENTIAL_LED_MAX_SF_PER_UNIT = 2500
# Splitting one condo into two inside a 100-unit building is not a development opportunity.
MINOR_RECONFIG_MIN_EXISTING = 12
MINOR_RECONFIG_MAX_ADDED = 2
NON_RESIDENTIAL_LED_MIN_SF_PER_UNIT = 4000


def residential_led_check(units: int, gross_sqft: int | None, nonres: list[str]) -> str | None:
    """Return a 'verify' reason if a project with units may not be residential-led, else None."""
    strong = sorted(set(nonres) & STRONG_NONRES)
    if gross_sqft and units:
        per_unit = gross_sqft / units
        if per_unit <= RESIDENTIAL_LED_MAX_SF_PER_UNIT:
            return None
        if per_unit >= NON_RESIDENTIAL_LED_MIN_SF_PER_UNIT:
            return f"verify_residential_led:{int(per_unit)}_gsf_per_unit" + (":" + ",".join(strong) if strong else "")
    if strong:
        return "verify_residential_led:" + ",".join(strong)
    return None
_ORDER = {QUALIFIED: 3, NEEDS_REVIEW: 2, REJECTED: 1}


def classify_filing(f: NormalizedFiling, min_units: int = 1, max_units: int = 200) -> tuple[str, list[str]]:
    types = set(f.project_types)
    dev = types & DEV_TYPES
    units = f.units_proposed
    nonres = [s for s in f.nonres_signals if s != "non_residential_occupancy" or not f.residential_signal]

    if f.record_class == "planning_document":
        if f.filing_kind in ("community_engagement", "administrative"):
            return REJECTED, [f"not_a_development_filing:{f.filing_kind}"]
        return NEEDS_REVIEW, ["document_evaluated_with_project"]
    if f.record_class == "certificate_of_occupancy":
        return REJECTED, ["completion_record_certificate_of_occupancy"]
    if f.stage == "denied_or_withdrawn":
        return REJECTED, ["denied_withdrawn_or_abandoned"]
    if f.record_class == "planning_project" and f.stage == "complete":
        return REJECTED, ["construction_complete"]
    if f.ordinary_work and not dev:
        return REJECTED, ["non_development_permit_or_ordinary_work"]

    if units is not None:
        if units > max_units:
            return REJECTED, [f"units_above_{max_units}"]
        if units < min_units:
            if nonres:
                return REJECTED, ["non_residential:" + ",".join(sorted(set(nonres)))]
            return REJECTED, ["no_residential_units"]

    if f.record_class == "planning_project":
        if units is None:
            if nonres and not f.residential_signal:
                return REJECTED, ["non_residential:" + ",".join(sorted(set(nonres)))]
            return NEEDS_REVIEW, ["units_unknown"]
        verify = residential_led_check(units, f.gross_sqft, nonres)
        if verify:
            return NEEDS_REVIEW, [verify]
        return QUALIFIED, [f"units_{units}_in_range", "article80_residential"]

    # permits, applications, zoning appeals
    if not dev:
        return REJECTED, ["no_development_scope"]
    if types & DEV_TYPES == {"addition"} and units is None:
        return REJECTED, ["addition_without_unit_evidence"]
    if (f.units_existing is not None and units is not None and units <= f.units_existing
            and not types & {"new_construction", "demolition_rebuild", "substantial_rehab"}):
        return REJECTED, ["no_additional_units"]
    if (f.units_existing is not None and units is not None and f.units_existing >= MINOR_RECONFIG_MIN_EXISTING
            and 0 < units - f.units_existing <= MINOR_RECONFIG_MAX_ADDED
            and not types & {"new_construction", "demolition_rebuild"}):
        return REJECTED, ["minor_unit_reconfiguration_in_existing_building"]
    if units is None:
        if nonres and not f.residential_signal:
            return REJECTED, ["non_residential:" + ",".join(sorted(set(nonres)))]
        if not f.residential_signal:
            return NEEDS_REVIEW, ["units_unknown", "residential_use_unconfirmed"]
        return NEEDS_REVIEW, ["units_unknown"]
    verify = residential_led_check(units, f.gross_sqft, nonres)
    if verify:
        return NEEDS_REVIEW, [verify]
    return QUALIFIED, [f"units_{units}_in_range", "development_scope:" + ",".join(sorted(dev))]


UNIT_SOURCE_PRIORITY = {
    "boston.a80_projects": 5, "boston.permit_applications": 4, "boston.building_permits": 3,
    "boston.zba": 2, "boston.a80_legacy": 1,
}


def pick_units(filings: Iterable[dict[str, Any]]) -> tuple[int | None, int | None, str | None, str]:
    """Choose the proposed unit count across linked filings.

    Structured official fields beat text extraction; within a tier, higher source priority and the most recent
    filing win. Returns (units, existing_units, source_label, confidence).
    """
    best = None
    usable = [f for f in filings if f.get("units_proposed") is not None and f.get("eligibility") != REJECTED
              and "enrichment_only_record" not in (f.get("eligibility_reasons") or [])]
    if not usable:   # only fall back to rejected records for display when nothing else states a count
        usable = [f for f in filings if f.get("units_proposed") is not None
                  and f.get("record_class") == "planning_project" and f.get("source_key") != "boston.a80_legacy"]
    for f in usable:
        structured = (f.get("units_source") or "").startswith("structured")
        legacy = f.get("source_key") == "boston.a80_legacy"
        key = (0 if legacy else 1, 1 if structured else 0, UNIT_SOURCE_PRIORITY.get(f.get("source_key"), 0),
               str(f.get("source_filing_date") or ""))
        if best is None or key > best[0]:
            best = (key, f)
    if best is None:
        return None, None, None, "unknown"
    f = best[1]
    structured = (f.get("units_source") or "").startswith("structured")
    conf = "high" if structured and f.get("source_key") != "boston.a80_legacy" else "medium"
    return f["units_proposed"], f.get("units_existing"), f"{f['source_key']}:{f.get('units_source')}", conf


def evaluate_project(filings: list[dict[str, Any]], units: int | None, stage: str | None,
                     min_units: int = 1, max_units: int = 200) -> tuple[str, list[str]]:
    """Aggregate eligibility for a project from its (non enrichment-only) filings."""
    active = [f for f in filings if f.get("source_key") != "boston.a80_legacy"]
    if not active:
        return NEEDS_REVIEW, ["no_primary_source"]
    if units is not None and units > max_units:
        return REJECTED, [f"units_above_{max_units}"]
    a80 = [f for f in active if f.get("record_class") == "planning_project"]
    if a80 and all(f.get("stage") == "complete" for f in a80) and stage == "complete":
        return REJECTED, ["construction_complete"]
    best = max(active, key=lambda f: _ORDER.get(f.get("eligibility"), 0))
    elig = best.get("eligibility")
    reasons = list(best.get("eligibility_reasons") or [])
    if elig == NEEDS_REVIEW and units is not None and min_units <= units <= max_units:
        # unit count now known from another linked filing
        blockers = [r for r in reasons if r.startswith(("verify_residential_led", "residential_use_unconfirmed",
                                                        "document_evaluated_with_project", "no_primary_source"))]
        has_dev = any(set(f.get("project_types") or []) & DEV_TYPES for f in active) or bool(a80)
        if not blockers and has_dev:
            return QUALIFIED, [f"units_{units}_in_range", "units_from_linked_filing"]
        if reasons == ["document_evaluated_with_project"] and has_dev:
            return QUALIFIED, [f"units_{units}_in_range", "units_from_linked_filing"]
    if elig == QUALIFIED and units is not None and units < min_units:
        return REJECTED, ["no_residential_units"]
    return elig or NEEDS_REVIEW, reasons
