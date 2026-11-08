"""Boston Article 80 development projects.

Two official ArcGIS services exist:

* CURRENT — gis.bostonplans.org Hosted/A80_project_points_display FeatureServer/0 (~1,000 projects,
  edited daily; same data as the CKAN "article80-development-projects" resource). Schema has NO
  developer / contact / cost fields.
* LEGACY — gisportal.boston.gov Planning/OpenData MapServer/6 ("Article80 Projects Active"). Rich schema
  (Developer, Proponent, Contact, Phone, eMail, ProposedCost …) but frozen: newest ModifiedDate is
  2016-02-03. Used only as dated enrichment, matched on the official ProjectID.

Both datasets are small, so each poll takes a complete snapshot and compares it to stored versions.
"""
from __future__ import annotations

from typing import AsyncIterator

from ...http import PoliteClient
from ...models import ContactPoint, NormalizedFiling, Party, RawRecord
from ...normalize import clean_str, parse_date, parse_datetime, parse_int
from ...stages import A80_STATUS_TO_STAGE
from ...textparse import (detect_project_types, extract_named_parties, extract_units, has_residential_signal,
                          nonresidential_signals)
from ..base import FetchContext, SourceAdapter, SourceMeta, UpstreamVersion

CURRENT_LAYER = "https://gis.bostonplans.org/hosting/rest/services/Hosted/A80_project_points_display/FeatureServer/0"
LEGACY_LAYER = "https://gisportal.boston.gov/arcgis/rest/services/Planning/OpenData/MapServer/6"
PROJECTS_PAGE = "https://www.bostonplans.org/projects/development-projects"


def project_slug(url: str | None) -> str | None:
    if not url:
        return None
    u = url.strip().rstrip("/").split("?")[0]
    if "/development-projects/" not in u:
        return None
    return u.rsplit("/", 1)[-1].lower() or None


async def _arcgis_snapshot(client: PoliteClient, layer: str, order_field: str, ctx: FetchContext,
                           page_size: int = 1000) -> AsyncIterator[list[dict]]:
    offset = 0
    while True:
        r = await client.get_json(f"{layer}/query", params={
            "where": "1=1", "outFields": "*", "outSR": "4326", "orderByFields": order_field,
            "resultOffset": offset, "resultRecordCount": page_size, "f": "json",
        })
        if "error" in (r.data or {}):
            from ...http import UpstreamError
            raise UpstreamError(f"ArcGIS error: {r.data['error']}")
        feats = r.data.get("features", [])
        ctx.pages += 1
        if feats:
            yield feats
        if not r.data.get("exceededTransferLimit") or not feats:
            return
        offset += len(feats)


class Article80ProjectsAdapter(SourceAdapter):
    meta = SourceMeta(
        key="boston.a80_projects",
        city_id="boston",
        name="Boston Article 80 Development Projects (Planning Dept. FeatureServer)",
        record_class="planning_project",
        official_url="https://data.boston.gov/dataset/article80-development-projects",
        api_url=CURRENT_LAYER,
        description="Current Article 80 (Large & Small Project Review) projects: status, last filed date, "
                    "board approval date, residential units, gross floor area, description, coordinates.",
        limitations="No developer, proponent, contact or cost fields in the current schema. last_filed_date "
                    "is a date (no time). Projects marked 'Construction Complete' are stored but not treated "
                    "as new leads. Updated by the Planning Department roughly daily (lastEditDate).",
        publication_cadence="Edited most days; lastEditDate exposed by the layer is used as a conditional check.",
        min_interval_s=300, max_interval_s=1800, lookback_days=0, reconcile_every_h=24, backfill_order=10,
    )

    async def check_upstream(self, client: PoliteClient) -> UpstreamVersion:
        r = await client.get_json(CURRENT_LAYER, params={"f": "json"})
        led = (r.data.get("editingInfo") or {}).get("lastEditDate") or \
              (r.data.get("editingInfo") or {}).get("dataLastEditDate")
        return UpstreamVersion(version=str(led) if led else None, updated_at=parse_datetime(led) if led else None)

    async def fetch(self, client, ctx):
        ctx.is_full_snapshot = True
        async for feats in _arcgis_snapshot(client, CURRENT_LAYER, "objectid", ctx):
            out = []
            for f in feats:
                a = dict(f.get("attributes") or {})
                if f.get("geometry"):
                    a["_geometry"] = f["geometry"]
                pid = a.get("project_id")
                if pid is None:
                    continue
                out.append(RawRecord(
                    source_key=self.meta.key, source_record_id=str(pid), payload=a,
                    source_url=clean_str(a.get("website_url")) or f"{CURRENT_LAYER}/query?where=project_id={pid}",
                    source_filing_date=parse_date(a.get("last_filed_date")),
                    source_updated_at=ctx.upstream.updated_at if ctx.upstream else None,
                ))
            yield out

    def normalize(self, raw: RawRecord) -> NormalizedFiling:
        a = raw.payload
        desc = clean_str(a.get("description"))
        name = clean_str(a.get("project__project_name"))
        street = " ".join(x for x in [clean_str(a.get("project_street_number")), clean_str(a.get("project_street_name")),
                                      clean_str(a.get("project_street_suffix"))] if x)
        status = clean_str(a.get("project_status"))
        units = parse_int(a.get("total_residential_units"))
        units_source = "structured:total_residential_units" if units is not None else None
        text_units = extract_units(desc)
        is_range = False
        if units is None and text_units.units is not None:
            units, units_source, is_range = text_units.units, f"text:{text_units.method}", text_units.is_range
        text = " ".join(x for x in [name, desc] if x)
        types = detect_project_types(desc)
        geom = a.get("_geometry") or {}
        lat = a.get("latitude") or geom.get("y")
        lon = a.get("longitude") or geom.get("x")
        filed = parse_date(a.get("last_filed_date"))
        approved = parse_date(a.get("last_board_approved_date"))
        people = [Party(role=p.role, name=p.name, source_field="description (official text)", evidence=p.evidence)
                  for p in extract_named_parties(desc)]
        stage = A80_STATUS_TO_STAGE.get((status or "").lower())
        url = clean_str(a.get("website_url"))
        return NormalizedFiling(
            source_key=self.meta.key, source_record_id=raw.source_record_id,
            record_class="planning_project", filing_kind="project_record",
            title=name, doc_type=clean_str(a.get("project__record_type")),
            address=street or name, neighborhood=clean_str(a.get("neighborhood")), zip=clean_str(a.get("project_zip_code")),
            lat=float(lat) if lat else None, lon=float(lon) if lon else None,
            units_proposed=units, units_source=units_source, units_is_range=is_range,
            gross_sqft=parse_int(a.get("gross_square_footage")),
            project_types=types, is_mixed_use=("mixed_use" in types) or None,
            nonres_signals=nonresidential_signals(text), residential_signal=has_residential_signal(desc) or bool(units),
            status=status, stage=stage, description=desc, people=people,
            related_ids={"a80_project_id": raw.source_record_id, "sam_ids": clean_str(a.get("sam_ids")),
                         "project_slug": project_slug(url), "last_board_approved_date": str(approved) if approved else None},
            document_url=url, source_url=raw.source_url, project_url=url,
            source_filing_date=filed, source_updated_at=raw.source_updated_at,
        )


class Article80LegacyAdapter(SourceAdapter):
    meta = SourceMeta(
        key="boston.a80_legacy",
        city_id="boston",
        name="Boston Article 80 Projects — legacy GIS layer (enrichment only)",
        record_class="planning_project",
        official_url=LEGACY_LAYER,
        api_url=LEGACY_LAYER,
        description="Legacy BRA layer with Developer, Proponent, Contact, Phone, eMail, ProposedCost, zoning "
                    "and review indicators.",
        limitations="FROZEN: newest ModifiedDate is 2016-02-03 and newest EnteredDate 2016-02-02. It cannot reveal "
                    "new filings. Used only to attach dated developer/contact/cost enrichment to projects that "
                    "share the official ProjectID; never creates projects or alerts.",
        publication_cadence="Not updated since February 2016.",
        min_interval_s=86400, max_interval_s=7 * 86400, lookback_days=0, reconcile_every_h=24 * 7,
        is_enrichment_only=True, backfill_order=90,
    )

    async def check_upstream(self, client):
        r = await client.get_json(f"{LEGACY_LAYER}/query", params={
            "where": "1=1", "f": "json", "outStatistics":
                '[{"statisticType":"max","onStatisticField":"ModifiedDate","outStatisticFieldName":"mx"},'
                '{"statisticType":"count","onStatisticField":"OBJECTID","outStatisticFieldName":"n"}]'})
        attrs = (r.data.get("features") or [{}])[0].get("attributes", {})
        mx = attrs.get("mx") or attrs.get("MX")
        n = attrs.get("n") or attrs.get("N")
        return UpstreamVersion(version=f"{mx}:{n}", updated_at=parse_datetime(mx) if mx else None)

    async def fetch(self, client, ctx):
        ctx.is_full_snapshot = True
        async for feats in _arcgis_snapshot(client, LEGACY_LAYER, "OBJECTID", ctx):
            out = []
            for f in feats:
                a = dict(f.get("attributes") or {})
                pid = a.get("ProjectID")
                if pid is None:
                    continue
                out.append(RawRecord(
                    source_key=self.meta.key, source_record_id=str(pid), payload=a,
                    source_url=f"{LEGACY_LAYER}/query?where=ProjectID%3D{pid}&outFields=*&f=html",
                    source_filing_date=parse_date(a.get("EnteredDate")),
                    source_updated_at=parse_datetime(a.get("ModifiedDate")),
                ))
            yield out

    def normalize(self, raw: RawRecord) -> NormalizedFiling:
        a = raw.payload
        modified = parse_date(a.get("ModifiedDate"))
        asof = f" (legacy BRA dataset, last modified {modified})" if modified else " (legacy BRA dataset)"
        people: list[Party] = []
        for field_name, role in (("Developer", "developer"), ("Proponent", "proponent"), ("Contact", "contact_person")):
            v = clean_str(a.get(field_name))
            if v and v.lower() not in ("n/a", "na", "none", "tbd"):
                people.append(Party(role=role, name=v, source_field=f"{field_name}{asof}"))
        contacts: list[ContactPoint] = []
        contact_name = clean_str(a.get("Contact")) or clean_str(a.get("Proponent")) or clean_str(a.get("Developer"))
        label = f"Project contact {contact_name}" if contact_name else "Project contact"
        if clean_str(a.get("Title")):
            label += f", {clean_str(a.get('Title'))}"
        for field_name, kind in (("Phone", "phone"), ("eMail", "email"), ("MailingAddress", "mailing_address")):
            v = clean_str(a.get(field_name))
            if v:
                contacts.append(ContactPoint(kind=kind, value=v, role_label=label + asof, source_field=field_name))
        units = parse_int(a.get("TotalResidentialUnits"))
        street = " ".join(x for x in [clean_str(a.get("ProjectStreetNum")), clean_str(a.get("ProjectStreetName"))] if x)
        return NormalizedFiling(
            source_key=self.meta.key, source_record_id=raw.source_record_id,
            record_class="planning_project", filing_kind="project_record",
            title=clean_str(a.get("ProjectName")), doc_type="Legacy Article 80 record",
            address=street or clean_str(a.get("ProjectName")), parcel_id=clean_str(a.get("ParcelID")),
            neighborhood=clean_str(a.get("ProjectNeighborhood")), zip=clean_str(a.get("ProjectZipCode")),
            lat=a.get("Lat"), lon=a.get("Lon"),
            units_proposed=units if units else None,
            units_source="structured:TotalResidentialUnits (legacy 2016)" if units else None,
            gross_sqft=parse_int(a.get("BldgSqFt")), retail_sqft=parse_int(a.get("Retail_sqft")),
            land_sqft=parse_int(a.get("LandSqFt")),
            proposed_cost=float(a["ProposedCost"]) if a.get("ProposedCost") else None,
            status=clean_str(a.get("Article80Status")), description=clean_str(a.get("Notes")),
            people=people, contacts=contacts,
            related_ids={"a80_project_id": raw.source_record_id, "zoning": clean_str(a.get("Zoning")),
                         "zoning_district": clean_str(a.get("ZoningDistrict")),
                         "article80_type": clean_str(a.get("Article80Type")),
                         "legacy_modified": str(modified) if modified else None},
            source_url=raw.source_url, source_filing_date=parse_date(a.get("EnteredDate")),
            source_updated_at=raw.source_updated_at, in_window=False, can_create_project=False,
            link_by_official_id_only=True,
        )
