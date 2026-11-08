"""Analyze Boston — Approved Building Permits (CKAN resource 6ddcd912-32a0-43df-9908-63574f8c7e77).

IMPORTANT: this dataset contains ISSUED permits (issued_date). It does not contain application-submission
timestamps; those come from the Zoning Reform Impact Tracker adapter (applications.py).
"""
from __future__ import annotations

import re

from ...models import NormalizedFiling, Party, RawRecord
from ...normalize import clean_str, parse_date, parse_datetime, parse_int, parse_money
from ...textparse import (detect_project_types, extract_units, has_residential_signal, is_ordinary_work,
                          is_unit_combination, nonresidential_signals)
from ..base import FetchContext, SourceAdapter, SourceMeta
from .ckan import dataset_url, resource_version, sql_pages, sql_quote, window_dates

RESOURCE_ID = "6ddcd912-32a0-43df-9908-63574f8c7e77"

# Permit types that are never development filings by themselves
NON_DEVELOPMENT_TYPES = re.compile(
    r"^(electrical|plumbing|gas|use of premises|electrical low voltage|electrical fire alarms|"
    r"electrical temporary service)", re.I)
NON_DEVELOPMENT_WORKTYPES = {
    "ROOF", "SOL", "SIGNES", "FA", "LVOLT", "SPRINK", "FENCE", "SPCEVE", "TMPSER", "GEN", "INSUL", "SIDE",
    "VIOL", "MAINT", "ELECTRICAL", "PLUMBING", "GAS", "SRVCHG", "SD", "RESPAR", "COB", "SITE", "TCOO",
}
WORKTYPE_TYPES = {
    "ERECT": ["new_construction"],
    "CHGOCC": ["conversion"],
    "ADDITION": ["addition"],
    "RAZE": ["demolition_only"],
    "EXTDEM": ["demolition_only"],
}
RESIDENTIAL_OCCUPANCY = {"1-2FAM", "1-3FAM", "1-4FAM", "MULTI", "MIXED", "7MORE", "2UNIT", "1UNIT", "3UNIT", "4UNIT"}


class BuildingPermitsAdapter(SourceAdapter):
    meta = SourceMeta(
        key="boston.building_permits",
        city_id="boston",
        name="Analyze Boston — Approved Building Permits",
        record_class="issued_permit",
        official_url=dataset_url("approved-building-permits"),
        api_url=f"https://data.boston.gov/api/3/action/datastore_search_sql (resource {RESOURCE_ID})",
        description="Issued building permits incl. permit number, work type, description/comments, applicant, "
                    "declared valuation, issued date, status, occupancy type, sq ft, address, parcel id, coordinates.",
        limitations="Issued permits only — no application-submission date. declared_valuation is the applicant's "
                    "declared construction value (not total development cost and not a loan request). The CKAN "
                    "resource is refreshed about once a day (observed ~20:25 UTC); resource_show.last_modified is "
                    "used as the conditional check before pulling data.",
        publication_cadence="Daily batch refresh.",
        min_interval_s=300, max_interval_s=3600, lookback_days=7, reconcile_every_h=24 * 7, backfill_order=50,
    )

    async def check_upstream(self, client):
        return await resource_version(client, RESOURCE_ID)

    async def fetch(self, client, ctx: FetchContext):
        start, end = window_dates(ctx.window_start, ctx.window_end)
        where = f"issued_date >= {sql_quote(start)} AND issued_date < ({sql_quote(end)}::date + 1)"
        async for recs in sql_pages(client, RESOURCE_ID, where):
            ctx.pages += 1
            yield [RawRecord(
                source_key=self.meta.key, source_record_id=str(r["permitnumber"]),
                payload={k: v for k, v in r.items() if k != "_id"},
                source_url=f"https://data.boston.gov/dataset/approved-building-permits?permit={r['permitnumber']}",
                source_filing_date=parse_date(r.get("issued_date")),
                source_updated_at=ctx.upstream.updated_at if ctx.upstream else None,
            ) for r in recs if r.get("permitnumber")]

    def normalize(self, raw: RawRecord) -> NormalizedFiling:
        r = raw.payload
        ptype = clean_str(r.get("permittypedescr")) or ""
        wt = (clean_str(r.get("worktype")) or "").upper()
        desc = clean_str(r.get("description"))
        comments = clean_str(r.get("comments"))
        text = " ".join(x for x in [desc, comments] if x)
        occ = (clean_str(r.get("occupancytype")) or "").upper()
        is_co = ptype.lower().startswith("certificate of occupancy") or raw.source_record_id.upper().startswith("COO")
        types = list(dict.fromkeys(WORKTYPE_TYPES.get(wt, []) + detect_project_types(comments)))
        if wt == "CHGOCC" and "conversion" not in types:
            types.append("conversion")
        non_dev = bool(NON_DEVELOPMENT_TYPES.match(ptype)) or wt in NON_DEVELOPMENT_WORKTYPES
        if ptype.lower().startswith("short form") and wt not in ("RAZE", "EXTDEM"):
            non_dev = True
        if is_unit_combination(comments):
            non_dev = True      # merging existing units is not a development
        if non_dev:
            types = []          # trade / short-form / special-event permits are never development scope
        units = extract_units(comments)
        residential = occ in RESIDENTIAL_OCCUPANCY or has_residential_signal(comments)
        nonres = nonresidential_signals(comments)
        if occ in ("COMM", "OTHER") and not has_residential_signal(comments):
            nonres.append("non_residential_occupancy")
        addr = clean_str(r.get("address"))
        city = clean_str(r.get("city"))
        app_no = raw.source_record_id
        people = []
        if clean_str(r.get("applicant")):
            people.append(Party(role="applicant", name=clean_str(r["applicant"]),
                                source_field="applicant (permit applicant — not necessarily owner or developer)"))
        stage = "complete" if is_co else ("permit_issued" if not non_dev else None)
        return NormalizedFiling(
            source_key=self.meta.key, source_record_id=raw.source_record_id,
            record_class="certificate_of_occupancy" if is_co else "issued_permit",
            filing_kind="completion" if is_co else "permit",
            title=f"{ptype or 'Permit'} — {desc or wt}", doc_type=f"{ptype} / {wt}".strip(" /"),
            address=addr, parcel_id=_parcel(r.get("parcel_id")),
            neighborhood=city if city and city.lower() != "boston" else None, zip=clean_str(r.get("zip")),
            lat=r.get("y_latitude"), lon=r.get("x_longitude"),
            units_proposed=units.units, units_existing=units.existing,
            units_source=f"text:{units.method}" if units.units is not None else None, units_is_range=units.is_range,
            gross_sqft=parse_int(r.get("sq_feet")) or None,
            declared_valuation=parse_money(r.get("declared_valuation")),
            project_types=types, is_mixed_use=("mixed_use" in types or occ == "MIXED") or None,
            nonres_signals=nonres,
            residential_signal=residential and occ not in ("COMM", "OTHER") or has_residential_signal(comments),
            ordinary_work=non_dev or (is_ordinary_work(text) and not types),
            status=clean_str(r.get("status")), stage=stage, description=comments or desc, people=people,
            related_ids={"application_number": _base_app(app_no), "permit_number": app_no, "worktype": wt,
                         "permit_type": ptype, "occupancy_type": occ, "property_id": r.get("property_id")},
            source_url=raw.source_url, source_filing_date=parse_date(r.get("issued_date")),
            source_updated_at=raw.source_updated_at or parse_datetime(r.get("issued_date")),
        )


def _parcel(v) -> str | None:
    if v in (None, ""):
        return None
    try:
        return f"{int(float(v)):010d}"
    except (TypeError, ValueError):
        return clean_str(v)


def _base_app(permit_number: str) -> str:
    """Permit numbers share the application number (e.g. ALT1109288 is both)."""
    return permit_number.upper()
