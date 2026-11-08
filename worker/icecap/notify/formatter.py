"""Alert message formatting (plain text, shared by Telegram and email)."""
from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from ..stages import label as stage_label

TZ = ZoneInfo("America/New_York")

HEADLINES = {
    "new_project": "NEW DEVELOPMENT FILING",
    "new_plan_submission": "NEW PLAN SUBMISSION — EXISTING PROJECT",
    "units_changed": "REVISED UNIT COUNT",
    "approval": "APPROVAL RECORDED",
    "permit_issued": "CONSTRUCTION PERMIT ISSUED",
    "status_changed": "STATUS CHANGE",
    "new_filing": "NEW FILING — EXISTING PROJECT",
}
TYPE_LABELS = {
    "new_construction": "New construction", "demolition_rebuild": "Demolition / rebuild",
    "conversion": "Conversion", "substantial_rehab": "Substantial rehab", "addition": "Addition",
    "adds_units": "Adds units", "mixed_use": "Mixed-use",
}
CLASS_LABELS = {
    "planning_project": "Article 80 planning record",
    "planning_document": "Planning document",
    "permit_application": "Building permit APPLICATION (not yet an issued permit)",
    "issued_permit": "ISSUED building permit",
    "certificate_of_occupancy": "Certificate of occupancy",
    "zoning_appeal": "Zoning Board of Appeal case",
}


def money(v: Any) -> str:
    if v is None:
        return "unknown"
    v = float(v)
    if v >= 1_000_000:
        return f"${v / 1_000_000:,.1f}M"
    if v >= 1_000:
        return f"${v / 1_000:,.0f}K"
    return f"${v:,.0f}"


def fmt_dt(dt: datetime | None) -> str:
    if not dt:
        return "unknown"
    return dt.astimezone(TZ).strftime("%Y-%m-%d %H:%M %Z")


def format_alert(event: dict, project: dict, filing: dict | None, parties: list[dict],
                 dashboard_url: str) -> tuple[str, str]:
    headline = HEADLINES.get(event["event_type"], "DEVELOPMENT UPDATE")
    addr = project.get("address") or project.get("name") or "Address not published"
    nbhd = project.get("neighborhood") or "neighborhood unknown"
    dev_roles = [p for p in parties if p["role"] in ("developer", "proponent")]
    other_roles = [p for p in parties if p["role"] in ("owner_of_record", "applicant", "zba_contact")]
    if dev_roles:
        dev_line = "; ".join(f"{p['name']} ({p['role']})" for p in dev_roles[:3])
    elif other_roles:
        dev_line = "Not published. Named: " + "; ".join(
            f"{p['name']} ({p['role'].replace('_', ' ')})" for p in other_roles[:3])
    else:
        dev_line = "Not published"
    units = project.get("units_proposed")
    units_line = f"{units}" if units is not None else "UNKNOWN (needs review)"
    if units is not None and project.get("units_confidence") == "medium":
        units_line += " (from official description text)"
    types = ", ".join(TYPE_LABELS.get(t, t) for t in project.get("project_types") or []) or "Not determined"
    if filing:
        types += f" | Record: {CLASS_LABELS.get(filing.get('record_class'), filing.get('record_class'))}"
        if filing.get("doc_type"):
            types += f" — {filing['doc_type']}"
    fin = []
    if project.get("proposed_cost"):
        fin.append(f"official project cost {money(project['proposed_cost'])}")
    if project.get("declared_valuation"):
        fin.append(f"declared construction valuation {money(project['declared_valuation'])} (not a loan request)")
    if project.get("est_loan_low") is not None:
        fin.append(f"est. loan {money(project['est_loan_low'])}–{money(project['est_loan_high'])} "
                   f"[{(project.get('financing_basis') or {}).get('method', 'estimate')}]")
    fin.append(f"fit: {project.get('financing_fit', 'uncertain')}")
    url = (filing or {}).get("document_url") or (filing or {}).get("source_url") or project.get("project_url") or ""
    missing = ", ".join(project.get("missing_data") or []) or "none"
    lines = [
        headline,
        f"{addr} / {nbhd}",
        f"Developer / Proponent: {dev_line}",
        f"Residential units: {units_line}",
        f"Project type: {types}",
        f"Stage: {stage_label(project.get('stage'))}",
        f"Source filing date: {event.get('source_filing_date') or 'unknown'}",
        f"First detected: {fmt_dt(event.get('detected_at'))}",
        f"Estimated cost / financing fit: {'; '.join(fin)}",
        f"Filing / document: {url or 'n/a'}",
        f"Confidence: {project.get('confidence', 'low')} | Missing: {missing}",
        f"Score: {project.get('score') if project.get('score') is not None else 'n/a'}/100 (research priority, not a financing need)",
        f"Update: {event.get('summary')}",
        f"Dashboard: {dashboard_url.rstrip('/')}/leads/{project['id']}",
    ]
    subject = f"[IceCap] {headline}: {addr}" + (f" — {units} units" if units is not None else "")
    return subject, "\n".join(lines)
