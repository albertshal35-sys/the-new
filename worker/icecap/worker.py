"""Durable worker: source scheduling with leases, missed-run recovery, notification dispatch,
digests and enrichment. Multiple workers can run safely (FOR UPDATE SKIP LOCKED + leases)."""
from __future__ import annotations

import asyncio
import logging
import signal
from datetime import datetime, timedelta, timezone

from .adapters import registry
from .adapters.boston import assessment
from .config import Config
from .db import Database, jsonb
from .http import PoliteClient
from .notify.channels import build_channels
from .notify.dispatcher import dispatch_due, enqueue_daily_digest, enqueue_weekly_report, next_local_time
from .pipeline import Pipeline
from .runner import run_source
from .settings_store import load_settings

log = logging.getLogger(__name__)


async def seed(db: Database) -> None:
    """Register cities and sources (idempotent; refreshes metadata)."""
    for cid, c in registry.CITIES.items():
        await db.execute(
            """INSERT INTO cities (id, name, state, timezone) VALUES (%s,%s,%s,%s)
               ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name""", cid, c["name"], c["state"], c["timezone"])
    for a in registry.ADAPTERS:
        m = a.meta
        await db.execute(
            """INSERT INTO sources (key, city_id, name, record_class, official_url, api_url, description, limitations,
                   publication_cadence, min_interval_s, max_interval_s, is_enrichment_only)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, official_url=EXCLUDED.official_url,
                   api_url=EXCLUDED.api_url, description=EXCLUDED.description, limitations=EXCLUDED.limitations,
                   publication_cadence=EXCLUDED.publication_cadence, min_interval_s=EXCLUDED.min_interval_s,
                   max_interval_s=EXCLUDED.max_interval_s, is_enrichment_only=EXCLUDED.is_enrichment_only""",
            m.key, m.city_id, m.name, m.record_class, m.official_url, m.api_url, m.description, m.limitations,
            m.publication_cadence, m.min_interval_s, m.max_interval_s, m.is_enrichment_only)
        await db.execute(
            """INSERT INTO source_state (source_key, current_interval_s) VALUES (%s,%s)
               ON CONFLICT (source_key) DO NOTHING""", m.key, m.min_interval_s)
    await db.execute(
        """INSERT INTO sources (key, city_id, name, record_class, official_url, api_url, description, limitations,
               publication_cadence, min_interval_s, max_interval_s, is_enrichment_only)
           VALUES (%s,'boston','Boston Property Assessment (owner of record) — enrichment','property_record',%s,%s,
               'Owner of record, mailing address, land use and existing residential units by parcel id.',
               'Annual assessment snapshot (fiscal year). Owner of record is not necessarily the developer or borrower. Looked up only for parcels of non-rejected projects.',
               'Annual', 600, 600, true)
           ON CONFLICT (key) DO UPDATE SET limitations=EXCLUDED.limitations""",
        assessment.SOURCE_KEY, assessment.DATASET_URL,
        f"https://data.boston.gov/api/3/action/datastore_search (resource {assessment.RESOURCE_ID})")
    await db.execute("INSERT INTO source_state (source_key, current_interval_s) VALUES (%s, 600) ON CONFLICT DO NOTHING",
                     assessment.SOURCE_KEY)


async def enrich_owners(db: Database, client: PoliteClient, settings: dict, cfg: Config, limit: int = 25) -> int:
    rows = await db.fetch(
        """SELECT DISTINCT p.parcel_id FROM projects p
           LEFT JOIN parcel_assessments pa ON pa.parcel_id = p.parcel_id
           WHERE p.parcel_id IS NOT NULL AND p.eligibility <> 'rejected' AND pa.parcel_id IS NULL
           LIMIT %s""", limit)
    done = 0
    pipeline = Pipeline(db, settings, cfg)
    try:
        for r in rows:
            pid = r["parcel_id"]
            info = await assessment.lookup_parcel(client, pid)
            async with db.tx() as conn:
                if info is None:
                    await conn.execute(
                        """INSERT INTO parcel_assessments (parcel_id, payload, found, source_url)
                           VALUES (%s, '{}'::jsonb, false, %s) ON CONFLICT (parcel_id) DO NOTHING""",
                        (pid, assessment.DATASET_URL))
                    continue
                await conn.execute(
                    """INSERT INTO parcel_assessments (parcel_id, owner, mail_address, land_use, res_units, land_sf,
                           gross_area, total_value, yr_built, payload, source_url)
                       VALUES (%(parcel_id)s,%(owner)s,%(mail_address)s,%(land_use)s,%(res_units)s,%(land_sf)s,
                           %(gross_area)s,%(total_value)s,%(yr_built)s,%(payload)s,%(source_url)s)
                       ON CONFLICT (parcel_id) DO NOTHING""", {**info, "payload": jsonb(info["payload"])})
                projects = await (await conn.execute("SELECT id FROM projects WHERE parcel_id=%s", (pid,))).fetchall()
                for p in projects:
                    if info["owner"]:
                        eid = await pipeline._upsert_entity(conn, info["owner"])
                        if eid:
                            await conn.execute(
                                """INSERT INTO project_entities (project_id, entity_id, role, source_key,
                                       source_record_id, source_url, evidence)
                                   VALUES (%s,%s,'owner_of_record',%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                                (p["id"], eid, assessment.SOURCE_KEY, pid, assessment.DATASET_URL,
                                 "Owner of record in Boston property assessment (not necessarily the developer)"))
                    await pipeline.recompute_project(conn, p["id"])
            done += 1
        await db.execute(
            """UPDATE source_state SET last_check_at=now(), last_success_at=now(), consecutive_failures=0,
                   last_error=NULL, records_total=(SELECT count(*) FROM parcel_assessments) WHERE source_key=%s""",
            assessment.SOURCE_KEY)
    except Exception as exc:
        log.exception("owner enrichment failed")
        await db.execute(
            """UPDATE source_state SET last_check_at=now(), last_error_at=now(), last_error=%s,
                   consecutive_failures=consecutive_failures+1 WHERE source_key=%s""", str(exc)[:1000],
            assessment.SOURCE_KEY)
    return done


async def run_pending_backfills(db, client, cfg, settings) -> list[dict]:
    """Initial backfill in dependency order (Article 80 first so later sources link to it)."""
    out = []
    for a in sorted(registry.ADAPTERS, key=lambda a: a.meta.backfill_order):
        st = await db.fetchrow(
            """SELECT ss.backfill_completed_at, s.enabled FROM source_state ss JOIN sources s ON s.key=ss.source_key
               WHERE ss.source_key=%s""", a.meta.key)
        if st and st["enabled"] and not st["backfill_completed_at"]:
            out.append(await run_source(db, client, cfg, settings, a, force_mode="backfill"))
    return out


async def claim_due(db: Database, worker_id: str, n: int) -> list[str]:
    keys = [a.meta.key for a in registry.ADAPTERS]
    rows = await db.fetch(
        """UPDATE source_state s SET lease_owner=%s, lease_expires_at=now() + interval '45 minutes',
               last_run_started_at=now()
           WHERE s.source_key IN (
               SELECT ss.source_key FROM source_state ss JOIN sources so ON so.key=ss.source_key
               WHERE so.enabled AND ss.source_key = ANY(%s) AND ss.next_run_at <= now()
                 AND (ss.lease_expires_at IS NULL OR ss.lease_expires_at < now())
                 AND (ss.circuit_open_until IS NULL OR ss.circuit_open_until <= now())
               ORDER BY ss.next_run_at LIMIT %s FOR UPDATE SKIP LOCKED)
           RETURNING s.source_key""", worker_id, keys, n)
    return [r["source_key"] for r in rows]


async def scheduled_jobs_tick(db: Database, client: PoliteClient, cfg: Config, settings: dict) -> None:
    now = datetime.now(timezone.utc)
    a = settings["alerts"]
    jobs = {
        "daily_digest": (a.get("daily_digest"), lambda: next_local_time(now, a["digest_hour_local"], a["timezone"])),
        "weekly_report": (a.get("weekly_report"), lambda: next_local_time(now, a["digest_hour_local"], a["timezone"],
                                                                          a["weekly_report_weekday"])),
        "owner_enrichment": (True, lambda: now.replace(microsecond=0) + timedelta(minutes=10)),
    }
    for key, (enabled, nxt) in jobs.items():
        row = await db.fetchrow("SELECT * FROM scheduled_jobs WHERE key=%s", key)
        if row is None:
            first = nxt() if key != "owner_enrichment" else now
            await db.execute("INSERT INTO scheduled_jobs (key, next_run_at) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                             key, first)
            continue
        if not enabled or row["next_run_at"] > now:
            continue
        claimed = await db.fetchrow(
            """UPDATE scheduled_jobs SET next_run_at=%s, last_run_at=now() WHERE key=%s AND next_run_at=%s
               RETURNING key""", nxt(), key, row["next_run_at"])
        if not claimed:
            continue
        try:
            if key == "daily_digest":
                await enqueue_daily_digest(db, cfg, now)
            elif key == "weekly_report":
                await enqueue_weekly_report(db, cfg, now)
            elif key == "owner_enrichment":
                await enrich_owners(db, client, settings, cfg)
            await db.execute("UPDATE scheduled_jobs SET last_status='success', last_error=NULL WHERE key=%s", key)
        except Exception as exc:
            log.exception("job %s failed", key)
            await db.execute("UPDATE scheduled_jobs SET last_status='error', last_error=%s WHERE key=%s",
                             str(exc)[:1000], key)


async def worker_main(cfg: Config) -> None:
    from .db import apply_migrations
    await apply_migrations(cfg.database_url)
    db = Database(cfg.database_url, max_size=cfg.max_concurrent_sources + 4)
    await db.open()
    client = PoliteClient(cfg.user_agent, timeout_s=cfg.http_timeout_s)
    await seed(db)
    # Missed-run recovery: expired leases from a crashed worker are released; overdue sources run immediately.
    await db.execute("UPDATE source_state SET lease_owner=NULL, lease_expires_at=NULL WHERE lease_expires_at < now()")
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    settings = await load_settings(db)
    channels = build_channels(cfg, client)
    log.info("worker %s starting; channels: %s", cfg.worker_id,
             {k: type(v).__name__ for k, v in channels.items()})
    await run_pending_backfills(db, client, cfg, settings)
    running: dict[str, asyncio.Task] = {}
    try:
        while not stop.is_set():
            settings = await load_settings(db)
            for k, t in list(running.items()):
                if t.done():
                    running.pop(k)
            free = cfg.max_concurrent_sources - len(running)
            if free > 0:
                for key in await claim_due(db, cfg.worker_id, free):
                    running[key] = asyncio.create_task(
                        run_source(db, client, cfg, settings, registry.get(key)), name=key)
            try:
                await dispatch_due(db, channels)
                await scheduled_jobs_tick(db, client, cfg, settings)
            except Exception:
                log.exception("tick failed")
            # sleep until the next tick, but wake as soon as a source run finishes so that
            # alerts it queued are dispatched immediately
            waiters = [asyncio.ensure_future(stop.wait()), *running.values()]
            done, _ = await asyncio.wait(waiters, timeout=cfg.scheduler_tick_s, return_when=asyncio.FIRST_COMPLETED)
            waiters[0].cancel()
    finally:
        for t in running.values():
            t.cancel()
        await client.aclose()
        await db.close()
