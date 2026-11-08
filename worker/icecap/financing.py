"""Estimated lending opportunity — clearly labelled estimates with assumptions and uncertainty.

Distinguishes:
* proposed_cost        — an officially stated project cost (if any source publishes one)
* declared_valuation   — the construction value an applicant declared on a building permit (hard cost proxy)
* estimated TDC        — total development cost range derived from one of the above or from unit count
* estimated loan range — TDC range × loan-to-cost assumptions
None of these is a loan request; no borrower need is implied.
"""
from __future__ import annotations

from typing import Any


def lending_category(project_types: list[str], stage: str | None) -> str:
    t = set(project_types or [])
    if stage == "complete":
        return "bridge"
    if "conversion" in t:
        return "conversion"
    if "substantial_rehab" in t:
        return "heavy_rehab"
    if t & {"new_construction", "demolition_rebuild", "addition", "adds_units"}:
        return "construction"
    return "unknown"


def _property_bucket(units: int | None) -> str:
    if units is None:
        return "multifamily"
    if units == 1:
        return "single_family"
    if units <= 4:
        return "two_to_four_family"
    return "multifamily"


def estimate(p: dict[str, Any], settings: dict) -> dict[str, Any]:
    fin = settings["financing"]
    max_loan = settings["business"]["max_loan"]
    units = p.get("units_proposed")
    category = lending_category(p.get("project_types") or [], p.get("stage"))
    ltc = fin["bridge_loan_to_cost"] if category == "bridge" else fin["loan_to_cost"]
    basis: dict[str, Any] = {"lending_category": category, "loan_to_cost": ltc, "assumptions": []}
    tdc_low = tdc_high = None

    if p.get("proposed_cost"):
        band = fin["official_cost_band"]
        tdc_low, tdc_high = p["proposed_cost"] * band[0], p["proposed_cost"] * band[1]
        basis["method"] = "official_proposed_cost"
        basis["assumptions"].append(f"Officially stated project cost ${p['proposed_cost']:,.0f} (±band {band}).")
    elif p.get("declared_valuation") and p["declared_valuation"] >= 50_000 and category in (
            "construction", "heavy_rehab", "conversion"):
        mult = fin["hard_cost_to_tdc"]
        v = float(p["declared_valuation"])
        tdc_low, tdc_high = v * mult[0], v * mult[1]
        basis["method"] = "declared_construction_valuation"
        basis["assumptions"].append(
            f"Declared construction valuation ${v:,.0f} on issued permit(s) treated as hard cost; "
            f"TDC = valuation × {mult[0]}–{mult[1]} for soft costs/land/financing.")
    elif units:
        per = fin["tdc_per_unit"]
        if category in ("conversion",):
            rng = per["conversion"]
        elif category == "heavy_rehab":
            rng = per["substantial_rehab"]
        elif set(p.get("project_types") or []) == {"addition"}:
            rng = per["addition"]
        else:
            rng = per["new_construction"][_property_bucket(units)]
        tdc_low, tdc_high = units * rng[0], units * rng[1]
        basis["method"] = "unit_count_x_per_unit_cost"
        basis["assumptions"].append(
            f"{units} units × ${rng[0]:,.0f}–${rng[1]:,.0f} per unit (Boston {category} assumption, editable).")
    else:
        basis["method"] = "none"
        basis["assumptions"].append("No unit count or cost evidence published; no estimate made.")
        return {"est_tdc_low": None, "est_tdc_high": None, "est_loan_low": None, "est_loan_high": None,
                "financing_fit": "uncertain", "lending_category": category, "financing_basis": basis}

    loan_low, loan_high = tdc_low * ltc[0], tdc_high * ltc[1]
    basis["assumptions"].append(f"Loan = TDC × {ltc[0]:.0%}–{ltc[1]:.0%} loan-to-cost. Not a borrower request.")
    if loan_high <= max_loan:
        fit = "likely"
    elif loan_low > max_loan:
        fit = "outside_scope"
    else:
        fit = "uncertain"
    if basis["method"] == "unit_count_x_per_unit_cost" and fit == "likely" and \
            (p.get("units_confidence") in ("low", "unknown")):
        fit = "uncertain"
    basis["max_loan"] = max_loan
    return {"est_tdc_low": round(tdc_low), "est_tdc_high": round(tdc_high),
            "est_loan_low": round(loan_low), "est_loan_high": round(loan_high),
            "financing_fit": fit, "lending_category": category, "financing_basis": basis}
