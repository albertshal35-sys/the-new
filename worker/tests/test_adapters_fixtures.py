"""Adapter normalization + eligibility against REAL captured responses from the official sources."""
from datetime import datetime, timezone

import httpx
import pytest
import respx

from conftest import ckan_records, load_fixture
from icecap.adapters.base import FetchContext
from icecap.adapters.boston.a80 import Article80LegacyAdapter, Article80ProjectsAdapter, project_slug
from icecap.adapters.boston.applications import PermitApplicationsAdapter
from icecap.adapters.boston.permits import BuildingPermitsAdapter
from icecap.adapters.boston.records_library import RecordsLibraryAdapter, classify_document
from icecap.adapters.boston.zba import ZoningAppealsAdapter
from icecap.eligibility import classify_filing
from icecap.http import PoliteClient
from icecap.models import RawRecord


def _raw(adapter, rid, payload, **kw):
    return RawRecord(source_key=adapter.meta.key, source_record_id=str(rid), payload=payload, **kw)


def test_a80_current_records():
    ad = Article80ProjectsAdapter()
    feats = {f["attributes"]["project_id"]: f for f in load_fixture("a80_fs_query.json")["features"]}
    def norm(pid):
        a = dict(feats[pid]["attributes"]); a["_geometry"] = feats[pid]["geometry"]
        f = ad.normalize(_raw(ad, pid, a))
        f.eligibility, f.eligibility_reasons = classify_filing(f)
        return f
    beach = norm(5058)   # 105 Beach Street: 15 rental units, adaptive reuse, Under Review
    assert beach.units_proposed == 15 and beach.units_source.startswith("structured")
    assert beach.stage == "under_review" and beach.eligibility == "qualified"
    assert "conversion" in beach.project_types
    assert beach.related_ids["project_slug"] == "105-beach-street"
    providence = norm(5059)  # 476 units -> above cap
    assert providence.eligibility == "rejected" and providence.eligibility_reasons == ["units_above_200"]
    wharf = norm(5068)   # boutique hotel, no residential units
    assert wharf.units_proposed is None
    assert wharf.eligibility == "rejected" and "hotel" in wharf.eligibility_reasons[0]
    assert [p.name for p in wharf.people if p.role == "proponent"] == ["US Wharf LLC"]


def test_a80_legacy_is_enrichment_only():
    ad = Article80LegacyAdapter()
    f0 = load_fixture("a80_legacy_query.json")["features"][0]["attributes"]
    f = ad.normalize(_raw(ad, f0["ProjectID"], f0))
    assert f.can_create_project is False and f.in_window is False
    assert all("legacy" in p.source_field for p in f.people)
    assert all("legacy" in c.role_label for c in f.contacts)


def test_permits_classification():
    ad = BuildingPermitsAdapter()
    recs = {r["permitnumber"]: r for r in ckan_records("permits_sql.json") + ckan_records("permits_erect.json")}
    def norm(pn):
        f = ad.normalize(_raw(ad, pn, recs[pn]))
        f.eligibility, f.eligibility_reasons = classify_filing(f)
        return f
    assert norm("SF1885940").eligibility == "rejected"           # roofing
    assert norm("G1916137").eligibility == "rejected"            # gas furnace
    assert norm("ALT1776819").eligibility == "rejected"          # office fit-out
    co = norm("COO1404847")
    assert co.record_class == "certificate_of_occupancy" and co.eligibility == "rejected"
    conv = norm("ALT1109288")                                      # one family -> three family + addition
    assert conv.units_proposed == 3 and conv.eligibility == "qualified" and "conversion" in conv.project_types
    erect = norm("ERT1102644")                                     # 32 units mixed use
    assert erect.units_proposed == 32 and erect.is_mixed_use and erect.eligibility == "qualified"
    assert erect.record_class == "issued_permit" and erect.stage == "permit_issued"
    assert erect.declared_valuation == 8274322.0
    assert erect.people[0].role == "applicant" and "not necessarily owner" in erect.people[0].source_field
    sfh = norm("ERT1277785")
    assert sfh.units_proposed == 1 and sfh.eligibility == "qualified"


def test_applications_units_before_after():
    ad = PermitApplicationsAdapter()
    recs = {r["Permit application number"]: r for r in ckan_records("zrit_sql.json")}
    def norm(apno):
        f = ad.normalize(_raw(ad, apno, recs[apno]))
        f.eligibility, f.eligibility_reasons = classify_filing(f)
        return f
    adds = norm("ALT1910421")   # change occupancy 2 -> 3
    assert (adds.units_existing, adds.units_proposed) == (2, 3)
    assert adds.record_class == "permit_application" and adds.stage == "permit_application"
    assert adds.eligibility == "qualified"
    same = norm("ALT1911183")   # change occupancy 2 -> 2
    assert same.eligibility == "rejected"
    reno = norm("ALT1911149")   # exterior renovation
    assert reno.eligibility == "rejected"


def test_zba_classification():
    ad = ZoningAppealsAdapter()
    recs = ckan_records("zba_sql.json")
    havre = next(r for r in recs if r["address"].startswith("196 Havre") and r["parent_apno"] == "ERT1179726")
    f = ad.normalize(_raw(ad, f"{havre['boa_apno']}:{havre['parent_apno']}", havre))
    f.eligibility, f.eligibility_reasons = classify_filing(f)
    assert f.units_proposed == 5 and f.eligibility == "qualified"
    assert f.related_ids["application_number"] == "ERT1179726"
    assert f.people[0].role == "zba_contact"


def test_records_library_classification():
    assert classify_document("Developer Filing", "Project Notification Form (PNF)") == ("developer_filing", "planning_filing")
    assert classify_document("Developer Filing", "Letter of Intent (LOI)") == ("developer_filing", "letter_of_intent")
    assert classify_document("Community Engagement", "Presentation")[0] == "community_engagement"
    assert classify_document("Community Engagement", "Video")[0] == "community_engagement"
    assert classify_document("Vote", "BPDA Board") == ("approval", "board_approved")
    assert classify_document("Executed Documents", "Determination Waiving Further Review")[0] == "approval"
    assert classify_document("Executed Documents", "Affordable Rental Housing Agreement (ARHAR)")[0] == "administrative"
    ad = RecordsLibraryAdapter()
    item = load_fixture("records_library_page1.json")["metadataObj"][0]
    f = ad.normalize(_raw(ad, item["boxMetadata"]["$parent"], {"boxMetadata": item["boxMetadata"], "shareLink": item["shareLink"]}))
    assert f.document_url.startswith("https://bpda.box.com/")
    assert f.related_ids["project_slug"] == project_slug(item["boxMetadata"]["url"])


@pytest.mark.asyncio
@respx.mock
async def test_records_library_pagination_follows_marker():
    page1 = load_fixture("records_library_page1.json")
    page1["next_marker"] = "MARK2"
    page2 = {"metadataObj": [{"boxMetadata": {"$parent": "file_999", "documentDate": "2026-10-02T00:00:00.000Z",
                                              "type": "Developer Filing", "subtype": "Small Project Review Application (SPRA)",
                                              "projectName": "1 Test St", "url": None}, "shareLink": "https://bpda.box.com/s/x"}],
             "totalcount": 51, "next_marker": ""}
    route = respx.get("https://sire.bostonplans.org/api/documentSearch/getMetadataWithProjects")
    route.side_effect = lambda req: httpx.Response(200, json=page2 if req.url.params["ft_next_marker"] == "MARK2" else page1)
    client = PoliteClient("test", max_retries=0)
    ctx = FetchContext(mode="incremental", window_start=datetime(2026, 10, 1, tzinfo=timezone.utc),
                       window_end=datetime(2026, 11, 8, tzinfo=timezone.utc))
    pages = [p async for p in RecordsLibraryAdapter().fetch(client, ctx)]
    await client.aclose()
    assert len(pages) == 2 and pages[1][0].source_record_id == "file_999"
    assert route.calls[0].request.url.params["ft_startDate"] == "2026-10-01"


@pytest.mark.asyncio
@respx.mock
async def test_ckan_keyset_pagination_and_retry():
    recs = ckan_records("permits_erect.json")
    calls = {"n": 0}
    def handler(req):
        calls["n"] += 1
        sql = req.url.params["sql"]
        if calls["n"] == 1:
            return httpx.Response(503, text="busy")          # transient failure is retried
        if '"_id" > 0' in sql:
            return httpx.Response(200, json={"success": True, "result": {"records": recs[:5]}})
        return httpx.Response(200, json={"success": True, "result": {"records": []}})
    respx.get("https://data.boston.gov/api/3/action/datastore_search_sql").mock(side_effect=handler)
    from icecap.adapters.boston.ckan import sql_pages
    client = PoliteClient("test", max_retries=2, backoff_base=0.01)
    pages = [p async for p in sql_pages(client, "res", "TRUE", page_size=5)]
    await client.aclose()
    assert [len(p) for p in pages] == [5]
    assert calls["n"] == 3   # 503, page 1, empty page 2


def _permit(ad, **over):
    base = ckan_records("permits_erect.json")[0]
    rec = {**base, **over}
    f = ad.normalize(_raw(ad, rec["permitnumber"], rec))
    f.eligibility, f.eligibility_reasons = classify_filing(f)
    return f


def test_regression_special_event_tents_are_not_development():
    f = _permit(BuildingPermitsAdapter(), permitnumber="SF1915607", permittypedescr="Short Form Bldg Permit",
                worktype="SPCEVE", occupancytype="Other",
                comments="Erect 50x115, (2) 10x40 and (4) 10x10 tents on 11/19/26, removal on 11/21/26.")
    assert f.project_types == [] and f.eligibility == "rejected"


def test_regression_hospital_gut_renovation_is_not_residential():
    f = _permit(BuildingPermitsAdapter(), permitnumber="ALT1898017", permittypedescr="Long Form/Alteration Permit",
                worktype="INTREN", occupancytype="Other",
                comments="Gut renovation of 17,000 sf of existing inpatient unit. Work includes removal of finishes.")
    assert "substantial_rehab" in f.project_types
    assert f.eligibility == "rejected" and f.eligibility_reasons[0].startswith("non_residential")


def test_residential_gut_rehab_goes_to_review_not_rejected():
    f = _permit(BuildingPermitsAdapter(), permitnumber="ALT1", permittypedescr="Long Form/Alteration Permit",
                worktype="INTREN", occupancytype="1-3FAM", comments="Gut rehab of existing three family dwelling.")
    assert f.eligibility in ("needs_review", "qualified")


def test_regression_condo_split_in_tower_is_not_development():
    f = _permit(BuildingPermitsAdapter(), permitnumber="ALT1829657", permittypedescr="Long Form/Alteration Permit",
                worktype="CHGOCC", occupancytype="Multi",
                comments="Change occupancy from 171 units to 172 units by Separating unit 5801/5802 (currently combined)")
    assert (f.units_existing, f.units_proposed) == (171, 172)
    assert f.eligibility == "rejected" and f.eligibility_reasons == ["minor_unit_reconfiguration_in_existing_building"]
    g = _permit(BuildingPermitsAdapter(), permitnumber="ALT1873829", permittypedescr="Long Form/Alteration Permit",
                worktype="CHGOCC", occupancytype="Multi",
                comments="combine units 3601 and 3606. Changing two residential units to 1 residential unit.")
    assert g.eligibility == "rejected"
