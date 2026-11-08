"""Boston Zoning Board of Appeal Tracker (CKAN resource 0f0fa8c2-87ba-45d6-a876-0d177dd02512)."""
from __future__ import annotations

from datetime import date

from ...models import NormalizedFiling, Party, RawRecord
from ...normalize import clean_str, parse_date
from ...textparse import (detect_project_types, extract_units, has_residential_signal, is_ordinary_work,
                          nonresidential_signals)
from ..base import FetchContext, SourceAdapter, SourceMeta
from .ckan import dataset_url, resource_version, sql_pages, sql_quote, window_dates

RESOURCE_ID = "0f0fa8c2-87ba-45d6-a876-0d177dd02512"
APPROVED = {"approved", "appprov"}
DENIED = {"denied", "deniedprej", "withdrawn", "withdraw", "void"}


class ZoningAppealsAdapter(SourceAdapter):
    meta = SourceMeta(
        key="boston.zba",
        city_id="boston",
        name="Boston Zoning Board of Appeal Tracker",
        record_class="zoning_appeal",
        official_url=dataset_url("zoning-board-of-appeal-tracker"),
        api_url=f"https://data.boston.gov/api/3/action/datastore_search_sql (resource {RESOURCE_ID})",
        description="ZBA appeals: address, status, parent permit application number, BOA number, contact, "
                    "submitted/hearing/decision dates, decision, zoning district and project description.",
        limitations="Daily batch. 'contact' is the person listed on the appeal (often an attorney/agent) — "
                    "not necessarily the owner or developer. No parcel id or coordinates.",
        publication_cadence="Daily batch refresh.",
        min_interval_s=300, max_interval_s=3600, lookback_days=14, reconcile_every_h=24, backfill_order=40,
    )

    async def check_upstream(self, client):
        return await resource_version(client, RESOURCE_ID)

    async def fetch(self, client, ctx: FetchContext):
        start, end = window_dates(ctx.window_start, ctx.window_end)
        s, e = sql_quote(start), sql_quote(end + "T23:59:59")
        where = " OR ".join(f"({c} >= {s} AND {c} <= {e})" for c in
                            ("submitted_date", "hearing_date", "final_decision_date", "closed_date"))
        async for recs in sql_pages(client, RESOURCE_ID, where):
            ctx.pages += 1
            out = []
            for r in recs:
                boa = clean_str(r.get("boa_apno"))
                if not boa:
                    continue
                rid = f"{boa}:{clean_str(r.get('parent_apno')) or '-'}".upper()
                out.append(RawRecord(
                    source_key=self.meta.key, source_record_id=rid, payload={k: v for k, v in r.items() if k != "_id"},
                    source_url=self.meta.official_url, source_filing_date=parse_date(r.get("submitted_date")),
                    source_updated_at=ctx.upstream.updated_at if ctx.upstream else None))
            yield out

    def normalize(self, raw: RawRecord) -> NormalizedFiling:
        r = raw.payload
        desc = clean_str(r.get("project_description"))
        decision = (clean_str(r.get("decision")) or "")
        status = clean_str(r.get("status"))
        if decision.lower() in APPROVED:
            kind, stage = "approval", "zoning_approved"
        elif decision.lower() in DENIED:
            kind, stage = "appeal", "denied_or_withdrawn"
        else:
            kind, stage = "appeal", "zoning_appeal"
        units = extract_units(desc)
        types = detect_project_types(desc)
        people = []
        if clean_str(r.get("contact")):
            people.append(Party(role="zba_contact", name=clean_str(r["contact"]),
                                source_field="contact (person listed on ZBA appeal — not necessarily owner)"))
        addr = clean_str(r.get("address"))
        parent = clean_str(r.get("parent_apno"))
        filed = parse_date(r.get("submitted_date"))
        decided = parse_date(r.get("final_decision_date"))
        return NormalizedFiling(
            source_key=self.meta.key, source_record_id=raw.source_record_id,
            record_class="zoning_appeal", filing_kind=kind,
            title=f"ZBA {clean_str(r.get('boa_apno'))} — {status or 'appeal'}" + (f" ({decision})" if decision else ""),
            doc_type=clean_str(r.get("appeal_type")) or "Zoning appeal",
            address=addr, neighborhood=clean_str(r.get("city")), zip=clean_str(r.get("zip")),
            units_proposed=units.units, units_existing=units.existing,
            units_source=f"text:{units.method}" if units.units is not None else None, units_is_range=units.is_range,
            project_types=types, is_mixed_use=("mixed_use" in types) or None,
            nonres_signals=nonresidential_signals(desc), residential_signal=has_residential_signal(desc),
            ordinary_work=is_ordinary_work(desc) and not types,
            status=" / ".join(x for x in [status, decision] if x) or None, stage=stage, description=desc, people=people,
            related_ids={"application_number": parent.upper() if parent else None, "boa_apno": clean_str(r.get("boa_apno")),
                         "hearing_date": clean_str(r.get("hearing_date")), "final_decision_date": str(decided) if decided else None,
                         "zoning_district": clean_str(r.get("zoning_district")), "ward": clean_str(r.get("ward"))},
            source_url=raw.source_url, source_filing_date=filed or decided,
            source_updated_at=raw.source_updated_at,
        )


def _latest(*dates: date | None) -> date | None:
    ds = [d for d in dates if d]
    return max(ds) if ds else None
