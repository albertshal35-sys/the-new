"""Boston building-permit APPLICATIONS via the official Zoning Reform Impact Tracker
(CKAN resource f9b736f2-60da-4240-b793-f9b498eb475e, dataset "zoning-reform-impact-tracker").

This is the only official open dataset found that exposes permit *application filing dates* and application
status (zoning review, appeal started/completed, issued, abandoned, inactive) together with structured
residential unit counts before/after the proposed work (populated for applications after Oct 2024).
"""
from __future__ import annotations

from ...models import NormalizedFiling, RawRecord
from ...normalize import clean_str, parse_date, parse_int
from ..base import FetchContext, SourceAdapter, SourceMeta
from .ckan import dataset_url, resource_version, sql_pages, sql_quote, window_dates

RESOURCE_ID = "f9b736f2-60da-4240-b793-f9b498eb475e"
F_FILED = "Permit application filing date"
F_ISSUED_DATE = "Permit issued date"
F_UNITS_BEFORE = "Residential units before permitted work-on and after Oct. 2024"
F_UNITS_AFTER = "Residential units after permitted work-on and after Oct. 2024"

WORK_TYPE_TYPES = {
    "erect": ["new_construction"],
    "change occupancy": ["conversion"],
    "addition": ["addition"],
}
ORDINARY_WORK_TYPES = {
    "signs", "solar panels", "roofing", "renovations - exterior", "fencing renovation >6ft", "outside seating",
    "residential parking", "commercial parking", "city of boston", "application to correct a violation",
}


def _t(v) -> bool:
    return str(v).strip().lower() in ("t", "true", "1", "yes")


class PermitApplicationsAdapter(SourceAdapter):
    meta = SourceMeta(
        key="boston.permit_applications",
        city_id="boston",
        name="Boston Building Permit Applications (Zoning Reform Impact Tracker)",
        record_class="permit_application",
        official_url=dataset_url("zoning-reform-impact-tracker"),
        api_url=f"https://data.boston.gov/api/3/action/datastore_search_sql (resource {RESOURCE_ID})",
        description="Permit applications with filing date, type/work type, zoning review, appeal, issuance, "
                    "abandonment, Article 80 flags, residential units before/after, parcel id, coordinates, "
                    "and links to ZBA decisions / Planning recommendations.",
        limitations="Published as a daily batch (not real time). No applicant/owner names and no description "
                    "text. Unit counts are only populated for applications after Oct 2024. Field semantics are "
                    "as defined by the City's tracker.",
        publication_cadence="Daily batch refresh.",
        min_interval_s=300, max_interval_s=3600, lookback_days=10, reconcile_every_h=24, backfill_order=30,
    )

    async def check_upstream(self, client):
        return await resource_version(client, RESOURCE_ID)

    async def fetch(self, client, ctx: FetchContext):
        start, end = window_dates(ctx.window_start, ctx.window_end)
        s, e = sql_quote(start), sql_quote(end + "T23:59:59")
        where = (f'("{F_FILED}" >= {s} AND "{F_FILED}" <= {e}) OR '
                 f'("{F_ISSUED_DATE}" >= {s} AND "{F_ISSUED_DATE}" <= {e})')
        async for recs in sql_pages(client, RESOURCE_ID, where):
            ctx.pages += 1
            yield [RawRecord(
                source_key=self.meta.key, source_record_id=str(r["Permit application number"]).upper(),
                payload={k: v for k, v in r.items() if k != "_id"},
                source_url=self.meta.official_url, source_filing_date=parse_date(r.get(F_FILED)),
                source_updated_at=ctx.upstream.updated_at if ctx.upstream else None,
            ) for r in recs if r.get("Permit application number")]

    def normalize(self, raw: RawRecord) -> NormalizedFiling:
        r = raw.payload
        wtype = (clean_str(r.get("Permit application work type")) or "")
        atype = clean_str(r.get("Permit application type")) or ""
        before = parse_int(r.get(F_UNITS_BEFORE))
        after = parse_int(r.get(F_UNITS_AFTER))
        types = list(WORK_TYPE_TYPES.get(wtype.lower(), []))
        if before is not None and after is not None and after > before and "conversion" not in types \
                and "new_construction" not in types:
            types.append("adds_units")
        if wtype.lower() == "change occupancy" and (after is None or before is None or after <= before):
            # change of occupancy without additional dwelling units — may be commercial
            types = ["conversion"] if after else []
        issued = _t(r.get("Permit issued"))
        if issued:
            stage, status = "permit_issued", "Permit issued"
        elif _t(r.get("Permit application abandoned")):
            stage, status = "denied_or_withdrawn", "Application abandoned"
        elif _t(r.get("Permit application inactive")):
            stage, status = "permit_application", "Application inactive"
        elif _t(r.get("Completed appeal")):
            stage, status = "zoning_appeal", "Zoning appeal completed"
        elif _t(r.get("Started appeal")):
            stage, status = "zoning_appeal", "Zoning appeal in progress"
        elif _t(r.get("Zoning review approved")):
            stage, status = "permit_application", "Zoning review approved"
        else:
            stage, status = "permit_application", "Application filed"
        ordinary = wtype.lower() in ORDINARY_WORK_TYPES or atype.upper() == "UOP" or \
            (wtype.lower().startswith("renovations") and not (after and before is not None and after > before))
        a80 = _t(r.get("Is Article 80?"))
        zba_link = clean_str(r.get("Zoning Board of Appeal decision link"))
        rec_link = clean_str(r.get("Planning Department recommendation link"))
        return NormalizedFiling(
            source_key=self.meta.key, source_record_id=raw.source_record_id,
            record_class="permit_application", filing_kind="application",
            title=f"Permit application {raw.source_record_id} — {atype} / {wtype}",
            doc_type=f"{atype} / {wtype}".strip(" /"),
            address=clean_str(r.get("Address")), parcel_id=clean_str(r.get("Parcel ID")),
            neighborhood=clean_str(r.get("Neighborhood")), zip=clean_str(r.get("Zip code")),
            lat=_f(r.get("Y latitude")), lon=_f(r.get("X longitude")),
            units_proposed=after if after else None, units_existing=before,
            units_source=f"structured:{F_UNITS_AFTER}" if after else None,
            project_types=types, residential_signal=bool(after) or bool(before),
            ordinary_work=ordinary, status=status, stage=stage,
            related_ids={"application_number": raw.source_record_id, "zba_application_number":
                         clean_str(r.get("Board of Appeal application number")), "is_article80": a80,
                         "article80_small": _t(r.get("Is Article 80 small project?")),
                         "article80_large": _t(r.get("Is Article 80 large project?")),
                         "zba_decision_link": zba_link, "planning_recommendation_link": rec_link,
                         "permit_issued_date": clean_str(r.get(F_ISSUED_DATE)), "sam_id": clean_str(r.get("SAM ID")),
                         "has_adu": _t(r.get("Permit application has ADU")),
                         "zoning_district": clean_str(r.get("Zoning district"))},
            document_url=zba_link or rec_link, source_url=raw.source_url,
            source_filing_date=parse_date(r.get(F_FILED)), source_updated_at=raw.source_updated_at,
        )


def _f(v):
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None
