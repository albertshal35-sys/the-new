"""Read-mostly REST API (FastAPI). The Next.js dashboard reads PostgreSQL directly for server rendering; this
API serves integrations, health checks and operational actions."""
from __future__ import annotations

import os
from datetime import date
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .config import get_config
from .db import Database

app = FastAPI(title="IceCap Development Intelligence API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("API_CORS_ORIGINS", "*").split(","),
                   allow_methods=["GET", "POST"], allow_headers=["*"])
_db: Database | None = None

UNIT_BUCKETS = {"1-4": (1, 4), "5-20": (5, 20), "21-50": (21, 50), "51-100": (51, 100), "101-200": (101, 200)}


@app.on_event("startup")
async def _startup() -> None:
    global _db
    _db = Database(get_config().database_url, max_size=6)
    await _db.open()


@app.on_event("shutdown")
async def _shutdown() -> None:
    if _db:
        await _db.close()


def db() -> Database:
    assert _db is not None
    return _db


@app.get("/health")
async def health() -> dict:
    row = await db().fetchrow("SELECT now() AS now, (SELECT count(*) FROM projects) AS projects")
    return {"ok": True, **row}


@app.get("/api/sources")
async def sources() -> list[dict]:
    return await db().fetch(
        """SELECT s.key, s.name, s.record_class, s.official_url, s.limitations, s.publication_cadence,
                  s.is_enrichment_only, ss.last_check_at, ss.last_success_at, ss.last_error_at, ss.last_error,
                  ss.consecutive_failures, ss.circuit_open_until, ss.next_run_at, ss.current_interval_s,
                  ss.upstream_updated_at, ss.newest_record_at, ss.records_total, ss.backfill_completed_at,
                  ss.watermark_ts, ss.last_change_detected_at,
                  EXTRACT(EPOCH FROM (now() - ss.newest_record_at))/3600 AS newest_record_age_h,
                  EXTRACT(EPOCH FROM (ss.last_check_at - ss.upstream_updated_at))/60 AS check_after_publish_min
           FROM sources s JOIN source_state ss ON ss.source_key=s.key ORDER BY s.key""")


@app.post("/api/sources/{key}/run")
async def trigger(key: str) -> dict:
    row = await db().fetchrow(
        "UPDATE source_state SET next_run_at=now(), circuit_open_until=NULL WHERE source_key=%s RETURNING source_key", key)
    if not row:
        raise HTTPException(404, "unknown source")
    return {"queued": key}


@app.get("/api/projects")
async def projects(
    eligibility: str | None = Query(None, pattern="^(qualified|needs_review|rejected)$"),
    units: str | None = Query(None, description="1-4 | 5-20 | 21-50 | 51-100 | 101-200"),
    neighborhood: str | None = None, stage: str | None = None, project_type: str | None = None,
    financing_fit: str | None = None, has_contact: bool | None = None, unread: bool | None = None,
    filed_from: date | None = None, filed_to: date | None = None, seen_from: date | None = None,
    seen_to: date | None = None, q: str | None = None,
    cursor: str | None = Query(None, description="keyset cursor '<first_seen_at iso>|<id>'"),
    limit: int = Query(50, ge=1, le=500),
) -> dict:
    where, args = ["TRUE"], []
    def add(sql: str, *a: Any) -> None:
        where.append(sql)
        args.extend(a)
    if eligibility:
        add("p.eligibility=%s", eligibility)
    if units in UNIT_BUCKETS:
        add("p.units_proposed BETWEEN %s AND %s", *UNIT_BUCKETS[units])
    if neighborhood:
        add("p.neighborhood=%s", neighborhood)
    if stage:
        add("p.stage=%s", stage)
    if project_type:
        add("%s = ANY(p.project_types)", project_type)
    if financing_fit:
        add("p.financing_fit=%s", financing_fit)
    if has_contact is not None:
        add("p.has_contact=%s", has_contact)
    if unread:
        add("NOT p.is_read")
    if filed_from:
        add("p.latest_filing_date >= %s", filed_from)
    if filed_to:
        add("p.latest_filing_date <= %s", filed_to)
    if seen_from:
        add("p.first_seen_at >= %s", seen_from)
    if seen_to:
        add("p.first_seen_at < (%s::date + 1)", seen_to)
    if q:
        add("(p.name ILIKE %s OR p.address ILIKE %s)", f"%{q}%", f"%{q}%")
    if cursor:
        ts, cid = cursor.rsplit("|", 1)
        add("(p.first_seen_at, p.id) < (%s::timestamptz, %s)", ts, int(cid))
    rows = await db().fetch(
        f"""SELECT p.id, p.name, p.address, p.neighborhood, p.parcel_id, p.units_proposed, p.units_confidence,
                   p.property_type, p.project_types, p.stage, p.eligibility, p.eligibility_reasons, p.financing_fit,
                   p.est_loan_low, p.est_loan_high, p.score, p.confidence, p.missing_data, p.has_contact,
                   p.latest_filing_date, p.first_seen_at, p.pipeline_status, p.is_read,
                   ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lon, e.name AS developer
            FROM projects p LEFT JOIN entities e ON e.id=p.developer_entity_id
            WHERE {' AND '.join(where)} ORDER BY p.first_seen_at DESC, p.id DESC LIMIT %s""", *args, limit)
    nxt = f"{rows[-1]['first_seen_at'].isoformat()}|{rows[-1]['id']}" if len(rows) == limit else None
    return {"items": rows, "next_cursor": nxt}


@app.get("/api/projects/{project_id}")
async def project(project_id: int) -> dict:
    p = await db().fetchrow("SELECT *, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon FROM projects WHERE id=%s",
                            project_id)
    if not p:
        raise HTTPException(404)
    p.pop("geom", None)
    p["filings"] = await db().fetch(
        """SELECT id, source_key, source_record_id, record_class, filing_kind, title, doc_type, status, stage,
                  units_proposed, units_source, declared_valuation, document_url, source_url, source_filing_date,
                  first_seen_at, eligibility, eligibility_reasons
           FROM filings WHERE project_id=%s ORDER BY source_filing_date DESC NULLS LAST""", project_id)
    p["parties"] = await db().fetch(
        """SELECT pe.role, e.id AS entity_id, e.name, pe.source_key, pe.source_url, pe.evidence
           FROM project_entities pe JOIN entities e ON e.id=pe.entity_id WHERE pe.project_id=%s""", project_id)
    p["contacts"] = await db().fetch("SELECT kind, value, role_label, is_city_staff, source_key, source_url "
                                     "FROM contacts WHERE project_id=%s", project_id)
    p["events"] = await db().fetch("SELECT * FROM project_events WHERE project_id=%s ORDER BY detected_at DESC",
                                   project_id)
    return p


@app.get("/api/feed")
async def feed(limit: int = Query(50, le=500), before_id: int | None = None,
               eligibility: str | None = None) -> list[dict]:
    return await db().fetch(
        """SELECT f.id, f.source_key, f.record_class, f.filing_kind, f.title, f.doc_type, f.address, f.units_proposed,
                  f.source_filing_date, f.first_seen_at, f.eligibility, f.document_url, f.project_id
           FROM filings f
           WHERE (%s::bigint IS NULL OR f.id < %s) AND (%s::text IS NULL OR f.eligibility=%s)
           ORDER BY f.first_seen_at DESC, f.id DESC LIMIT %s""", before_id, before_id, eligibility, eligibility, limit)


@app.get("/api/notifications")
async def notifications(limit: int = Query(100, le=500)) -> list[dict]:
    return await db().fetch(
        """SELECT id, event_id, kind, channel, status, attempts, last_error, created_at, sent_at, subject
           FROM notifications ORDER BY id DESC LIMIT %s""", limit)


@app.get("/api/metrics/latency")
async def latency() -> dict:
    return await db().fetchrow(
        """SELECT
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.detected_at - e.source_published_at))/60)
                 FILTER (WHERE e.source_published_at IS NOT NULL AND (e.suppressed_reason IS NULL OR e.suppressed_reason NOT IN ('backfill','reprocess')))
                 AS median_publish_to_detect_min,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (n.sent_at - e.detected_at)))
                 FILTER (WHERE n.sent_at IS NOT NULL) AS median_detect_to_notify_s,
             count(*) FILTER (WHERE n.status='sent') AS delivered, count(*) FILTER (WHERE n.status='mocked') AS mocked
           FROM project_events e LEFT JOIN notifications n ON n.event_id=e.id""")
