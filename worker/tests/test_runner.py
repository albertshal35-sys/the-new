"""Scheduler/runner behaviour: modes, windows, conditional checks, circuit breaker, adaptive polling."""
from datetime import datetime, timedelta, timezone

import pytest

from icecap.adapters.base import FetchContext, SourceAdapter, SourceMeta, UpstreamVersion
from icecap.http import PoliteClient, UpstreamError
from icecap.models import NormalizedFiling, RawRecord
from icecap.runner import choose_mode, compute_window, next_interval, run_source

NOW = datetime(2026, 11, 8, 12, tzinfo=timezone.utc)


class FakeAdapter(SourceAdapter):
    meta = SourceMeta(key="boston.zba", city_id="boston", name="fake", record_class="zoning_appeal",
                      official_url="x", api_url="x", description="", limitations="", publication_cadence="",
                      min_interval_s=300, max_interval_s=3600, lookback_days=14)

    def __init__(self, version="v1", fail=False, records=None):
        self.version, self.fail, self.records = version, fail, records or []
        self.fetch_calls = []

    async def check_upstream(self, client):
        if self.fail:
            raise UpstreamError("boom")
        return UpstreamVersion(self.version, NOW - timedelta(minutes=30))

    async def fetch(self, client, ctx: FetchContext):
        self.fetch_calls.append((ctx.mode, ctx.window_start, ctx.window_end))
        yield self.records

    def normalize(self, raw):
        return NormalizedFiling(source_key=self.meta.key, source_record_id=raw.source_record_id,
                                record_class="zoning_appeal", filing_kind="appeal", address="1 Main St",
                                project_types=["new_construction"], units_proposed=6, residential_signal=True,
                                source_filing_date=raw.source_filing_date)


def test_mode_and_window():
    ad = FakeAdapter()
    assert choose_mode({}, ad, NOW) == "backfill"
    st = {"backfill_completed_at": NOW, "last_run_stats": {"last_reconcile_at": (NOW - timedelta(hours=1)).isoformat()}}
    assert choose_mode(st, ad, NOW) == "incremental"
    st["last_run_stats"]["last_reconcile_at"] = (NOW - timedelta(hours=30)).isoformat()
    assert choose_mode(st, ad, NOW) == "reconcile"
    s, e = compute_window("backfill", {}, ad, NOW, 365)
    assert (e - s).days == 365 and e == NOW                       # rolling, not calendar year
    s, e = compute_window("incremental", {"watermark_ts": NOW - timedelta(hours=2)}, ad, NOW, 365)
    assert s == NOW - timedelta(hours=2) - timedelta(days=14)     # overlapping lookback


def test_adaptive_interval():
    ad = FakeAdapter()
    assert next_interval({"current_interval_s": 1200}, ad, True, NOW) == 300
    assert next_interval({"current_interval_s": 300}, ad, False, NOW) == 450
    assert next_interval({"current_interval_s": 3000}, ad, False, NOW) == 3600
    assert next_interval({"current_interval_s": 3000, "last_run_stats": {"publish_hours_utc": [12]}}, ad, False, NOW) == 300


@pytest.mark.asyncio
async def test_run_source_unchanged_skips_fetch_and_circuit_breaker(db, settings, config):
    client = PoliteClient("t")
    recs = [RawRecord("boston.zba", "BOA1:ERT1", {"x": 1}, source_filing_date=NOW.date())]
    ad = FakeAdapter(records=recs)
    r = await run_source(db, client, config, settings, ad)
    assert r["mode"] == "backfill" and r["inserted"] == 1
    st = await db.fetchrow("SELECT * FROM source_state WHERE source_key='boston.zba'")
    assert st["backfill_completed_at"] and st["upstream_version"] == "v1" and st["newest_record_at"]
    r = await run_source(db, client, config, settings, ad)          # reconcile due? no -> backfill set last_reconcile
    assert r["status"] == "unchanged" and len(ad.fetch_calls) == 1  # conditional check prevented a data pull
    ad.version = "v2"
    r = await run_source(db, client, config, settings, ad)
    assert r["status"] == "success" and r["mode"] == "incremental" and r["unchanged"] == 1
    bad = FakeAdapter(fail=True)
    for _ in range(5):
        r = await run_source(db, client, config, settings, bad)
        assert r["status"] == "error"
    st = await db.fetchrow("SELECT consecutive_failures, circuit_open_until, last_error FROM source_state WHERE source_key='boston.zba'")
    assert st["consecutive_failures"] == 5 and st["circuit_open_until"] is not None and "boom" in st["last_error"]
    runs = await db.fetch("SELECT status FROM ingestion_runs ORDER BY id")
    assert [x["status"] for x in runs][:3] == ["success", "unchanged", "success"]
    await client.aclose()
