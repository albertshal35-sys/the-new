"""Integration tests against PostgreSQL/PostGIS using real captured fixtures."""
import copy
from datetime import datetime, timezone

import pytest

from conftest import ckan_records, load_fixture
from icecap.adapters.boston.a80 import Article80ProjectsAdapter
from icecap.adapters.boston.applications import PermitApplicationsAdapter
from icecap.adapters.boston.permits import BuildingPermitsAdapter
from icecap.adapters.boston.zba import ZoningAppealsAdapter
from icecap.models import RawRecord
from icecap.notify.channels import MockChannel, SendResult
from icecap.notify.dispatcher import dispatch_due
from icecap.pipeline import Pipeline, RunContext

pytestmark = pytest.mark.asyncio


def a80_raws():
    ad = Article80ProjectsAdapter()
    out = []
    for f in load_fixture("a80_fs_query.json")["features"]:
        a = dict(f["attributes"]); a["_geometry"] = f["geometry"]
        out.append(RawRecord(ad.meta.key, str(a["project_id"]), a, source_url=a["website_url"]))
    return ad, out


def ctx(mode="incremental"):
    return RunContext(mode=mode, alerts_enabled=(mode != "backfill"),
                      source_published_at=datetime(2026, 11, 7, 23, 2, tzinfo=timezone.utc))


async def test_backfill_records_but_never_alerts(db, settings, config):
    ad, raws = a80_raws()
    p = Pipeline(db, settings, config)
    c = ctx("backfill")
    await p.process_page(ad, raws, c)
    assert c.stats["inserted"] == 3
    assert (await db.fetchrow("SELECT count(*) n FROM notifications"))["n"] == 0
    ev = await db.fetch("SELECT event_type, alertable, suppressed_reason FROM project_events")
    assert ev and all(not e["alertable"] and e["suppressed_reason"] == "backfill" for e in ev)
    proj = await db.fetchrow("SELECT * FROM projects WHERE a80_project_id='5058'")
    assert proj["eligibility"] == "qualified" and proj["units_proposed"] == 15
    assert proj["new_project_event_id"] is not None   # recorded silently: will never be announced later


async def test_new_qualifying_project_alerts_once_and_reimport_is_silent(db, settings, config):
    ad, raws = a80_raws()
    p = Pipeline(db, settings, config)
    await p.process_page(ad, raws, ctx())
    notes = await db.fetch("SELECT channel, kind, body FROM notifications")
    # only 105 Beach Street (15 units) qualifies; 476-unit project and hotel do not alert
    assert {n["channel"] for n in notes} == {"telegram", "email"} and len(notes) == 2
    assert "105 Beach Street" in notes[0]["body"] and "NEW DEVELOPMENT FILING" in notes[0]["body"]
    # re-import identical payloads: no new raw versions, events or notifications
    c2 = ctx()
    await p.process_page(ad, a80_raws()[1], c2)
    assert c2.stats["unchanged"] == 3 and c2.stats["events"] == 0
    assert (await db.fetchrow("SELECT count(*) n FROM notifications"))["n"] == 2
    first = await db.fetchrow("SELECT first_seen_at FROM filings WHERE source_record_id='5058'")
    # material change: unit count revised -> separate units_changed alert, raw version 2
    changed = a80_raws()[1]
    for r in changed:
        if r.source_record_id == "5058":
            r.payload = copy.deepcopy(r.payload); r.payload["total_residential_units"] = 18
    c3 = ctx()
    await p.process_page(ad, changed, c3)
    assert c3.stats["changed"] == 1
    ev = await db.fetchrow("SELECT * FROM project_events WHERE event_type='units_changed'")
    assert ev["alertable"] and "15 → 18" in ev["summary"]
    assert (await db.fetchrow("SELECT count(*) n FROM notifications"))["n"] == 4
    raw = await db.fetchrow("SELECT version FROM raw_records WHERE source_record_id='5058'")
    assert raw["version"] == 2
    assert (await db.fetchrow("SELECT count(*) n FROM raw_record_versions"))["n"] == 4
    f = await db.fetchrow("SELECT first_seen_at, last_changed_at, source_filing_date FROM filings WHERE source_record_id='5058'")
    assert f["first_seen_at"] == first["first_seen_at"] and f["last_changed_at"] > f["first_seen_at"]
    assert str(f["source_filing_date"]) == "2026-08-28"
    # non-material change (description text only) does not alert
    desc_only = copy.deepcopy(changed)
    for r in desc_only:
        if r.source_record_id == "5058":
            r.payload["description"] = r.payload["description"] + " "
    c4 = ctx()
    await p.process_page(ad, desc_only, c4)
    assert c4.stats["changed"] == 1 and c4.stats["events"] == 0


async def test_cross_source_linking_by_application_number(db, settings, config):
    p = Pipeline(db, settings, config)
    zba_ad = ZoningAppealsAdapter()
    havre = [r for r in ckan_records("zba_sql.json") if r["address"].startswith("196 Havre")]
    await p.process_page(zba_ad, [RawRecord(zba_ad.meta.key, f"{r['boa_apno']}:{r['parent_apno']}", r) for r in havre],
                         ctx("backfill"))
    # a later issued permit sharing the parent application number links to the same project
    pad = BuildingPermitsAdapter()
    permit = copy.deepcopy(ckan_records("permits_erect.json")[0])
    permit["permitnumber"] = "ERT1179726"
    permit["address"] = "196 Havre ST"
    await p.process_page(pad, [RawRecord(pad.meta.key, "ERT1179726", permit)], ctx())
    rows = await db.fetch("SELECT source_key, project_id FROM filings WHERE related_ids->>'application_number'='ERT1179726'")
    assert len({r["project_id"] for r in rows}) == 1 and len(rows) == 2
    ev = await db.fetchrow("SELECT event_type, alertable FROM project_events WHERE event_type='permit_issued'")
    assert ev is not None


async def test_rejected_permits_do_not_create_projects(db, settings, config):
    p = Pipeline(db, settings, config)
    pad = BuildingPermitsAdapter()
    recs = [r for r in ckan_records("permits_sql.json") if r["permitnumber"] in ("SF1885940", "G1916137")]
    await p.process_page(pad, [RawRecord(pad.meta.key, r["permitnumber"], r) for r in recs], ctx())
    assert (await db.fetchrow("SELECT count(*) n FROM projects"))["n"] == 0
    assert (await db.fetchrow("SELECT count(*) n FROM filings WHERE eligibility='rejected'"))["n"] == 2


async def test_application_creates_needs_review_or_qualified(db, settings, config):
    p = Pipeline(db, settings, config)
    ad = PermitApplicationsAdapter()
    recs = ckan_records("zrit_sql.json")
    await p.process_page(ad, [RawRecord(ad.meta.key, r["Permit application number"], r) for r in recs], ctx("backfill"))
    q = await db.fetch("SELECT link_key, units_proposed, eligibility FROM projects ORDER BY id")
    assert q and all(r["eligibility"] == "qualified" for r in q)
    assert {r["link_key"] for r in q} >= {"app:ALT1910421"}


class FailingChannel:
    async def send(self, subject, body):
        raise RuntimeError("smtp down")


async def test_dispatcher_mock_and_retry_to_dead(db, settings, config):
    ad, raws = a80_raws()
    await Pipeline(db, settings, config).process_page(ad, raws, ctx())
    out = await dispatch_due(db, {"telegram": MockChannel("telegram", "no creds"), "email": FailingChannel()})
    assert out["mocked"] == 1 and out["failed"] == 1
    tg = await db.fetchrow("SELECT status, sent_at FROM notifications WHERE channel='telegram'")
    assert tg["status"] == "mocked" and tg["sent_at"] is not None
    # mocked deliveries never mark the event as alerted
    assert (await db.fetchrow("SELECT count(*) n FROM project_events WHERE alerted_at IS NOT NULL"))["n"] == 0
    # exhaust retries
    for _ in range(8):
        await db.execute("UPDATE notifications SET next_attempt_at=now() WHERE status='failed'")
        await dispatch_due(db, {"email": FailingChannel()})
    em = await db.fetchrow("SELECT status, attempts, last_error FROM notifications WHERE channel='email'")
    assert em["status"] == "dead" and em["attempts"] == 6 and "smtp down" in em["last_error"]

    class OkChannel:
        async def send(self, s, b):
            return SendResult(ok=True, provider_message_id="42")
    await db.execute("UPDATE notifications SET status='pending', attempts=0, next_attempt_at=now() WHERE channel='email'")
    await dispatch_due(db, {"email": OkChannel()})
    assert (await db.fetchrow("SELECT count(*) n FROM project_events WHERE alerted_at IS NOT NULL"))["n"] == 1


async def test_quiet_hours_defer_notifications(db, settings, config):
    settings["alerts"]["quiet_hours"] = {"start": "00:00", "end": "23:59", "tz": "UTC"}
    ad, raws = a80_raws()
    await Pipeline(db, settings, config).process_page(ad, raws, ctx())
    row = await db.fetchrow("SELECT min(next_attempt_at) AS t FROM notifications")
    assert row["t"] > datetime.now(timezone.utc)
    assert (await dispatch_due(db, {"telegram": MockChannel("t", "x"), "email": MockChannel("e", "x")}))["mocked"] == 0


async def test_reprocess_reclassifies_without_alerting(db, settings, config):
    from icecap.pipeline import reprocess
    ad, raws = a80_raws()
    await Pipeline(db, settings, config).process_page(ad, raws, ctx("backfill"))
    before = await db.fetchrow("SELECT count(*) n FROM project_events")
    settings["business"]["max_units"] = 10          # rule change: 15-unit project no longer qualifies
    stats = await reprocess(db, settings, config, ["boston.a80_projects"])
    assert stats["unchanged"] == 3 and stats["inserted"] == 0
    p = await db.fetchrow("SELECT eligibility, eligibility_reasons FROM projects WHERE a80_project_id='5058'")
    assert p is None or p["eligibility"] == "rejected"
    assert (await db.fetchrow("SELECT count(*) n FROM notifications"))["n"] == 0
    assert (await db.fetchrow("SELECT count(*) n FROM raw_record_versions"))["n"] == 3   # no fake versions
    settings["business"]["max_units"] = 200
    await reprocess(db, settings, config, ["boston.a80_projects"])
    ev = await db.fetch("SELECT alertable FROM project_events")
    assert len(ev) >= 1 and not any(e["alertable"] for e in ev)
    p = await db.fetchrow("SELECT eligibility, new_project_event_id FROM projects WHERE a80_project_id='5058'")
    assert p["eligibility"] == "qualified" and p["new_project_event_id"] is not None   # silently announced
