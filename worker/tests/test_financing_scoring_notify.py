from datetime import date, datetime, timezone

from icecap.eligibility import evaluate_project, pick_units
from icecap.financing import estimate, lending_category
from icecap.notify.formatter import format_alert
from icecap.pipeline import quiet_hours_release
from icecap.scoring import score


def test_valuation_is_not_loan_and_cap_is_not_rejection(settings):
    # declared valuation -> TDC range -> loan range; nothing equals the declared valuation itself
    r = estimate({"units_proposed": 32, "project_types": ["new_construction"], "declared_valuation": 8_274_322}, settings)
    assert r["financing_basis"]["method"] == "declared_construction_valuation"
    assert r["est_loan_low"] != 8_274_322 and r["est_tdc_low"] > 8_274_322
    assert r["financing_fit"] == "likely"
    big = estimate({"units_proposed": 190, "project_types": ["new_construction"], "proposed_cost": 140_000_000}, settings)
    assert big["financing_fit"] == "outside_scope"   # flagged, not rejected — eligibility is separate
    mid = estimate({"units_proposed": 150, "project_types": ["new_construction"]}, settings)
    assert mid["financing_fit"] == "uncertain"


def test_no_basis_no_estimate(settings):
    r = estimate({"units_proposed": None, "project_types": []}, settings)
    assert r["est_loan_low"] is None and r["financing_fit"] == "uncertain"
    assert "No unit count" in r["financing_basis"]["assumptions"][0]


def test_lending_category():
    assert lending_category(["conversion"], "under_review") == "conversion"
    assert lending_category(["substantial_rehab"], None) == "heavy_rehab"
    assert lending_category(["new_construction"], "permit_issued") == "construction"
    assert lending_category(["new_construction"], "complete") == "bridge"


def test_score_bounds_and_weights(settings):
    best = {"units_proposed": 40, "stage": "under_review", "financing_fit": "likely", "est_loan_high": 20e6,
            "latest_filing_date": date.today(), "has_verified_contact": True, "developer_other_projects": 3}
    s, br = score(best, settings, date.today())
    assert s == 100 and set(br) == set(settings["scoring"]["weights"])
    worst, _ = score({"units_proposed": 500}, settings, date.today())
    assert 0 <= worst < 20
    settings["scoring"]["weights"] = {**settings["scoring"]["weights"], "contact_quality": 0}
    s2, _ = score({**best, "has_verified_contact": False}, settings, date.today())
    assert s2 == 100


def test_pick_units_prefers_structured_over_text():
    filings = [
        {"source_key": "boston.building_permits", "units_proposed": 30, "units_source": "text:explicit_unit_count",
         "source_filing_date": date(2026, 10, 1), "eligibility": "qualified", "record_class": "issued_permit"},
        {"source_key": "boston.a80_projects", "units_proposed": 28, "units_source": "structured:total_residential_units",
         "source_filing_date": date(2026, 1, 1), "eligibility": "qualified", "record_class": "planning_project"},
    ]
    u, _, src, conf = pick_units(filings)
    assert (u, conf) == (28, "high") and src.startswith("boston.a80_projects")


def test_evaluate_project_upgrades_needs_review_when_units_known():
    filings = [{"source_key": "boston.records_library", "eligibility": "needs_review", "record_class": "planning_document",
                "eligibility_reasons": ["document_evaluated_with_project"], "project_types": []},
               {"source_key": "boston.permit_applications", "eligibility": "needs_review", "record_class": "permit_application",
                "eligibility_reasons": ["units_unknown"], "project_types": ["new_construction"]}]
    assert evaluate_project(filings, 12, "permit_application")[0] == "qualified"
    assert evaluate_project(filings, None, "permit_application")[0] == "needs_review"
    assert evaluate_project(filings, 250, None) == ("rejected", ["units_above_200"])


def test_quiet_hours():
    qh = {"start": "22:00", "end": "07:00", "tz": "America/New_York"}
    inside = datetime(2026, 11, 8, 4, 0, tzinfo=timezone.utc)      # 23:00 ET
    rel = quiet_hours_release(qh, inside)
    assert rel == datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc)  # 07:00 ET
    outside = datetime(2026, 11, 8, 17, 0, tzinfo=timezone.utc)    # 12:00 ET
    assert quiet_hours_release(qh, outside) == outside
    assert quiet_hours_release(None, outside) == outside


def test_alert_format_has_required_fields_and_no_invented_values():
    event = {"event_type": "new_project", "summary": "New qualifying project", "source_filing_date": date(2026, 10, 30),
             "detected_at": datetime(2026, 11, 8, 15, 0, tzinfo=timezone.utc)}
    project = {"id": 7, "address": "105 Beach Street", "neighborhood": "Leather District", "units_proposed": None,
               "project_types": ["conversion"], "stage": "under_review", "financing_fit": "uncertain",
               "confidence": "low", "missing_data": ["unit count", "developer/proponent"], "score": 41}
    subject, body = format_alert(event, project, {"record_class": "planning_document", "doc_type": "PNF",
                                                  "document_url": "https://bpda.box.com/s/abc"}, [], "http://dash")
    for needle in ["NEW DEVELOPMENT FILING", "105 Beach Street / Leather District", "Developer / Proponent: Not published",
                   "Residential units: UNKNOWN", "Project type: Conversion", "Stage: Under Article 80 review",
                   "Source filing date: 2026-10-30", "First detected: 2026-11-08 10:00 EST",
                   "fit: uncertain", "https://bpda.box.com/s/abc", "Missing: unit count, developer/proponent"]:
        assert needle in body, needle
    assert "units" not in subject.split(":")[-1]  # no unit count invented in the subject
    _, body2 = format_alert(event, {**project, "units_proposed": 15}, None,
                            [{"role": "applicant", "name": "Jane Doe"}], "http://dash")
    assert "Not published. Named: Jane Doe (applicant)" in body2
