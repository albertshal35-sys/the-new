"""Ingestion pipeline: raw versioning -> normalization -> eligibility -> linking -> project recompute -> events.

Idempotent: re-processing an unchanged record only bumps last_seen_at. Events carry unique dedupe keys,
notifications carry unique (event, channel) keys, so re-imports never re-alert.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from .adapters.base import SourceAdapter
from .config import Config
from .db import Database, jsonb
from .eligibility import DEV_TYPES, QUALIFIED, REJECTED, classify_filing, evaluate_project, pick_units
from .financing import estimate
from .linking import attach_orphans, create_project, entity_kind, find_project
from .models import NormalizedFiling, RawRecord
from .normalize import address_keys, changed_fields, content_hash, fingerprint, normalize_address, normalize_entity_name
from .notify.formatter import format_alert
from .scoring import score
from .stages import rank

log = logging.getLogger(__name__)


ENRICHMENT_SOURCES = {"boston.a80_legacy"}


@dataclass
class RunContext:
    mode: str                         # backfill | incremental | reconcile
    alerts_enabled: bool
    source_published_at: datetime | None = None
    stats: dict[str, int] = field(default_factory=lambda: {
        "fetched": 0, "inserted": 0, "changed": 0, "unchanged": 0, "qualified": 0, "needs_review": 0,
        "rejected": 0, "events": 0, "alerts_queued": 0, "errors": 0})


def _filing_dict(f: NormalizedFiling) -> dict:
    d = asdict(f)
    d["people"] = [asdict(p) for p in f.people]
    d["contacts"] = [asdict(c) for c in f.contacts]
    return d


class Pipeline:
    def __init__(self, db: Database, settings: dict, config: Config):
        self.db = db
        self.settings = settings
        self.config = config

    # ------------------------------------------------------------------ page processing
    async def process_page(self, adapter: SourceAdapter, raws: list[RawRecord], ctx: RunContext,
                           force: bool = False) -> None:
        """Process a page of raw records. force=True re-normalizes unchanged records (rule changes)."""
        by_id: dict[str, RawRecord] = {}
        for r in raws:
            by_id[r.source_record_id] = r
        ctx.stats["fetched"] += len(by_id)
        if not by_id:
            return
        key = adapter.meta.key
        existing = {row["source_record_id"]: row for row in await self.db.fetch(
            "SELECT id, source_record_id, content_hash FROM raw_records WHERE source_key=%s AND source_record_id = ANY(%s)",
            key, list(by_id))}
        unchanged_ids = []
        todo: list[tuple[RawRecord, str]] = []
        for rid, raw in by_id.items():
            h = content_hash(raw.payload)
            ex = existing.get(rid)
            if ex and ex["content_hash"] == h and not force:
                unchanged_ids.append(ex["id"])
            else:
                todo.append((raw, h))
        if unchanged_ids:
            await self.db.execute(
                "UPDATE raw_records SET last_seen_at=now(), removed_upstream_at=NULL WHERE id = ANY(%s)", unchanged_ids)
            ctx.stats["unchanged"] += len(unchanged_ids)
        for raw, h in todo:
            try:
                async with self.db.tx() as conn:
                    await self._process_record(conn, adapter, raw, h, ctx)
            except Exception:  # one bad record must not stop the run
                ctx.stats["errors"] += 1
                log.exception("failed to process %s %s", key, raw.source_record_id)

    async def _process_record(self, conn, adapter: SourceAdapter, raw: RawRecord, h: str, ctx: RunContext) -> None:
        biz = self.settings["business"]
        f = adapter.normalize(raw)
        if f is None:
            return
        if f.link_by_official_id_only and not f.can_create_project:
            # enrichment-only records (e.g. frozen 2016 legacy layer) are never leads on their own
            f.eligibility, f.eligibility_reasons = REJECTED, ["enrichment_only_record"]
        else:
            f.eligibility, f.eligibility_reasons = classify_filing(f, biz["min_units"], biz["max_units"])
        ctx.stats[f.eligibility] += 1

        # --- raw record + version history
        old_raw = await (await conn.execute(
            "SELECT id, version, payload, content_hash FROM raw_records WHERE source_key=%s AND source_record_id=%s FOR UPDATE",
            (raw.source_key, raw.source_record_id))).fetchone()
        if old_raw is not None and old_raw["content_hash"] == h:
            raw_id, version = old_raw["id"], old_raw["version"]       # forced re-normalization, payload unchanged
            ctx.stats["unchanged"] += 1
        elif old_raw is None:
            raw_id = (await (await conn.execute(
                """INSERT INTO raw_records (source_key, source_record_id, content_hash, payload, source_url,
                       source_filing_date, source_updated_at) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                (raw.source_key, raw.source_record_id, h, jsonb(raw.payload), raw.source_url,
                 raw.source_filing_date, raw.source_updated_at))).fetchone())["id"]
            version = 1
            ctx.stats["inserted"] += 1
        else:
            raw_id, version = old_raw["id"], old_raw["version"] + 1
            await conn.execute(
                """UPDATE raw_records SET content_hash=%s, payload=%s, source_url=%s, source_filing_date=%s,
                       source_updated_at=%s, last_seen_at=now(), last_changed_at=now(), version=%s,
                       removed_upstream_at=NULL WHERE id=%s""",
                (h, jsonb(raw.payload), raw.source_url, raw.source_filing_date, raw.source_updated_at, version, raw_id))
            ctx.stats["changed"] += 1
        if old_raw is None or old_raw["content_hash"] != h:
            await conn.execute(
                """INSERT INTO raw_record_versions (raw_record_id, version, content_hash, payload, changed_fields)
                   VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (raw_id, version, h, jsonb(raw.payload),
                 jsonb(changed_fields(old_raw["payload"], raw.payload)) if old_raw else None))

        # --- filing
        fp = fingerprint(f.material_values())
        old = await (await conn.execute(
            """SELECT id, material_fingerprint, units_proposed, stage, status, eligibility, project_id,
                      source_filing_date, doc_type FROM filings WHERE source_key=%s AND source_record_id=%s FOR UPDATE""",
            (f.source_key, f.source_record_id))).fetchone()
        filing_id = await self._upsert_filing(conn, f, raw_id, fp, old)

        # --- project linking
        project_id = old["project_id"] if old else None
        created = False
        if project_id is None:
            project_id = await find_project(conn, f)
            if project_id is None and f.can_create_project and f.in_window and f.eligibility != REJECTED:
                project_id, created = await create_project(conn, f, adapter.meta.city_id)
            if project_id is not None:
                await conn.execute("UPDATE filings SET project_id=%s WHERE id=%s", (project_id, filing_id))
                if created and await attach_orphans(conn, project_id):
                    await self._sync_parties_from_filings(conn, project_id)
        if project_id is None:
            return
        if f.link_by_official_id_only and old is not None:
            pa = await (await conn.execute("SELECT a80_project_id FROM projects WHERE id=%s", (project_id,))).fetchone()
            if not pa or pa["a80_project_id"] != str(f.related_ids.get("a80_project_id")):
                await conn.execute("UPDATE filings SET project_id=NULL WHERE id=%s", (filing_id,))
                await self.recompute_project(conn, project_id)
                return
        if f.related_ids.get("a80_project_id") and f.source_key == "boston.a80_projects":
            await conn.execute(
                """UPDATE projects SET a80_project_id=COALESCE(a80_project_id, %s),
                       project_slug=COALESCE(project_slug, %s) WHERE id=%s
                   AND NOT EXISTS (SELECT 1 FROM projects p2 WHERE p2.a80_project_id=%s AND p2.id<>%s)""",
                (f.related_ids["a80_project_id"], f.related_ids.get("project_slug"), project_id,
                 f.related_ids["a80_project_id"], project_id))

        await self._sync_parties(conn, project_id, f)
        before, after = await self.recompute_project(conn, project_id)

        # --- events
        material_change = old is not None and old["material_fingerprint"] != fp
        if old is None or material_change:
            await self._emit_events(conn, f, filing_id, old, after, created, ctx)
        elif f.source_key not in ENRICHMENT_SOURCES:
            # eligibility changed without a material source change (rule change, linked enrichment):
            # record the announcement (silently when alerts are disabled, e.g. reprocess)
            await self._ensure_announcement(conn, after, filing_id, f, created, ctx)

    async def _upsert_filing(self, conn, f: NormalizedFiling, raw_id: int, fp: str, old: dict | None) -> int:
        geom = "ST_SetSRID(ST_MakePoint(%(lon)s::float8, %(lat)s::float8), 4326)::geography" \
            if f.lat is not None and f.lon is not None else "NULL"
        params = {
            "sk": f.source_key, "sid": f.source_record_id, "raw": raw_id, "rc": f.record_class, "fk": f.filing_kind,
            "title": f.title, "dt": f.doc_type, "addr": f.address, "norm": normalize_address(f.address),
            "keys": address_keys(f.address), "parcel": f.parcel_id, "nbhd": f.neighborhood, "zip": f.zip,
            "lat": f.lat, "lon": f.lon, "u": f.units_proposed, "ue": f.units_existing, "us": f.units_source,
            "gsf": f.gross_sqft, "rsf": f.retail_sqft, "val": f.declared_valuation, "cost": f.proposed_cost,
            "pt": None, "types": f.project_types, "mixed": f.is_mixed_use, "status": f.status, "stage": f.stage,
            "desc": f.description, "people": jsonb([asdict(p) for p in f.people]),
            "contacts": jsonb([asdict(c) for c in f.contacts]), "rel": jsonb(f.related_ids),
            "doc": f.document_url, "src": f.source_url, "fd": f.source_filing_date, "su": f.source_updated_at,
            "fp": fp, "el": f.eligibility, "er": f.eligibility_reasons,
        }
        if old is None:
            row = await (await conn.execute(f"""
                INSERT INTO filings (source_key, source_record_id, raw_record_id, record_class, filing_kind, title,
                    doc_type, address, address_norm, address_keys, parcel_id, neighborhood, zip, geom,
                    units_proposed, units_existing, units_source, gross_sqft, retail_sqft, declared_valuation,
                    proposed_cost, property_type, project_types, is_mixed_use, status, stage, description, people,
                    contacts, related_ids, document_url, source_url, source_filing_date, source_updated_at,
                    material_fingerprint, eligibility, eligibility_reasons)
                VALUES (%(sk)s,%(sid)s,%(raw)s,%(rc)s,%(fk)s,%(title)s,%(dt)s,%(addr)s,%(norm)s,%(keys)s,%(parcel)s,
                    %(nbhd)s,%(zip)s,{geom},%(u)s,%(ue)s,%(us)s,%(gsf)s,%(rsf)s,%(val)s,%(cost)s,%(pt)s,%(types)s,
                    %(mixed)s,%(status)s,%(stage)s,%(desc)s,%(people)s,%(contacts)s,%(rel)s,%(doc)s,%(src)s,%(fd)s,
                    %(su)s,%(fp)s,%(el)s,%(er)s) RETURNING id""", params)).fetchone()
            return row["id"]
        params["id"] = old["id"]
        await conn.execute(f"""
            UPDATE filings SET raw_record_id=%(raw)s, record_class=%(rc)s, filing_kind=%(fk)s, title=%(title)s,
                doc_type=%(dt)s, address=%(addr)s, address_norm=%(norm)s, address_keys=%(keys)s, parcel_id=%(parcel)s,
                neighborhood=%(nbhd)s, zip=%(zip)s, geom={geom}, units_proposed=%(u)s, units_existing=%(ue)s,
                units_source=%(us)s, gross_sqft=%(gsf)s, retail_sqft=%(rsf)s, declared_valuation=%(val)s,
                proposed_cost=%(cost)s, project_types=%(types)s, is_mixed_use=%(mixed)s, status=%(status)s,
                stage=%(stage)s, description=%(desc)s, people=%(people)s, contacts=%(contacts)s, related_ids=%(rel)s,
                document_url=%(doc)s, source_url=%(src)s, source_filing_date=%(fd)s, source_updated_at=%(su)s,
                last_changed_at = CASE WHEN material_fingerprint <> %(fp)s THEN now() ELSE last_changed_at END,
                material_fingerprint=%(fp)s, eligibility=%(el)s, eligibility_reasons=%(er)s
            WHERE id=%(id)s""", params)
        return old["id"]

    # ------------------------------------------------------------------ parties
    async def _upsert_entity(self, conn, name: str) -> int | None:
        norm = normalize_entity_name(name)
        if not norm:
            return None
        row = await (await conn.execute(
            """INSERT INTO entities (name, name_norm, kind) VALUES (%s,%s,%s)
               ON CONFLICT (name_norm) DO UPDATE SET name=entities.name RETURNING id""",
            (name, norm, entity_kind(name)))).fetchone()
        return row["id"]

    async def _sync_parties(self, conn, project_id: int, f: NormalizedFiling) -> None:
        for p in f.people:
            eid = await self._upsert_entity(conn, p.name)
            if eid is None:
                continue
            await conn.execute(
                """INSERT INTO project_entities (project_id, entity_id, role, source_key, source_record_id, source_url, evidence)
                   VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (project_id, entity_id, role) DO NOTHING""",
                (project_id, eid, p.role, f.source_key, f.source_record_id, f.source_url or f.document_url,
                 p.evidence or p.source_field))
        for c in f.contacts:
            await conn.execute(
                """INSERT INTO contacts (project_id, kind, value, role_label, is_city_staff, source_key, source_url)
                   VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (project_id, kind, value) DO NOTHING""",
                (project_id, c.kind, c.value, c.role_label, c.is_city_staff, f.source_key, f.source_url))

    async def _sync_parties_from_filings(self, conn, project_id: int) -> None:
        """Copy role-labelled people/contacts from every filing linked to a project (after re-linking)."""
        from .models import ContactPoint, Party
        rows = await (await conn.execute(
            """SELECT source_key, source_record_id, source_url, document_url, people, contacts
               FROM filings WHERE project_id=%s AND (people <> '[]'::jsonb OR contacts <> '[]'::jsonb)""",
            (project_id,))).fetchall()
        for r in rows:
            fake = NormalizedFiling(source_key=r["source_key"], source_record_id=r["source_record_id"],
                                    record_class="", filing_kind="", source_url=r["source_url"],
                                    document_url=r["document_url"],
                                    people=[Party(**p) for p in r["people"] or []],
                                    contacts=[ContactPoint(**c) for c in r["contacts"] or []])
            await self._sync_parties(conn, project_id, fake)

    # ------------------------------------------------------------------ project recompute
    async def recompute_project(self, conn, project_id: int) -> tuple[dict, dict]:
        before = await (await conn.execute("SELECT * FROM projects WHERE id=%s FOR UPDATE", (project_id,))).fetchone()
        filings = await (await conn.execute(
            """SELECT id, source_key, record_class, filing_kind, title, address, parcel_id, neighborhood, zip,
                      ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon, units_proposed, units_existing,
                      units_source, gross_sqft, retail_sqft, declared_valuation, proposed_cost, project_types,
                      is_mixed_use, status, stage, description, source_filing_date, eligibility, eligibility_reasons,
                      related_ids, document_url
               FROM filings WHERE project_id=%s""", (project_id,))).fetchall()
        biz = self.settings["business"]
        primary = [f for f in filings if f["source_key"] != "boston.a80_legacy"]
        relevant = [f for f in primary if f["eligibility"] != REJECTED] or primary
        units, units_existing, units_source, units_conf = pick_units(filings)

        a80 = next((f for f in primary if f["source_key"] == "boston.a80_projects"), None)
        legacy = next((f for f in filings if f["source_key"] == "boston.a80_legacy"), None)
        stage_f = [f for f in primary if rank(f["stage"]) is not None and f["eligibility"] != REJECTED] or \
            [f for f in primary if rank(f["stage"]) is not None]
        stage = None
        if a80 and a80["stage"]:
            stage = a80["stage"]
            if a80["stage"] != "complete":
                later = [f["stage"] for f in stage_f if rank(f["stage"]) > rank(stage) and f["stage"] != "complete"]
                if later:
                    stage = max(later, key=rank)
        elif stage_f:
            stage = max((f["stage"] for f in stage_f), key=rank)

        types: list[str] = []
        for f in relevant:
            for t in f["project_types"] or []:
                if t not in types:
                    types.append(t)
        if "demolition_only" in types:
            types.remove("demolition_only")
            if "new_construction" in types and "demolition_rebuild" not in types:
                types.append("demolition_rebuild")
        mixed = any(f["is_mixed_use"] for f in relevant) or "mixed_use" in types

        def first(field_name, prefer=("boston.a80_projects", "boston.permit_applications", "boston.building_permits",
                                      "boston.zba", "boston.records_library", "boston.a80_legacy")):
            for sk in prefer:
                for f in filings:
                    if f["source_key"] == sk and f.get(field_name) not in (None, ""):
                        return f[field_name]
            return None

        parcel = first("parcel_id", ("boston.permit_applications", "boston.building_permits", "boston.a80_legacy"))
        address = (a80 or {}).get("address") or first("address")
        lat, lon = first("lat"), first("lon")
        gross = first("gross_sqft", ("boston.a80_projects", "boston.a80_legacy", "boston.building_permits"))
        retail = first("retail_sqft", ("boston.a80_legacy",))
        proposed_cost = first("proposed_cost", ("boston.a80_legacy",))
        dev_permits = [f for f in primary if f["record_class"] == "issued_permit" and f["eligibility"] != REJECTED
                       and f["declared_valuation"]]
        declared = sum(float(f["declared_valuation"]) for f in dev_permits) if dev_permits else None
        dates = [f["source_filing_date"] for f in primary if f["source_filing_date"]]
        review_status = (a80 or {}).get("status") or first("status", ("boston.zba", "boston.permit_applications"))

        # parties / contacts
        roles = await (await conn.execute(
            """SELECT pe.role, pe.entity_id, e.name FROM project_entities pe JOIN entities e ON e.id=pe.entity_id
               WHERE pe.project_id=%s""", (project_id,))).fetchall()
        dev = next((r for r in roles if r["role"] == "developer"), None) or \
            next((r for r in roles if r["role"] == "proponent"), None)
        has_contact = bool((await (await conn.execute(
            "SELECT 1 FROM contacts WHERE project_id=%s AND NOT is_city_staff AND kind IN ('phone','email') LIMIT 1",
            (project_id,))).fetchone()))
        other_projects = None
        ent_ids = [r["entity_id"] for r in roles if r["role"] in ("developer", "proponent", "owner_of_record")]
        if ent_ids:
            row = await (await conn.execute(
                """SELECT count(DISTINCT project_id) AS n FROM project_entities
                   WHERE entity_id = ANY(%s) AND project_id <> %s AND role IN ('developer','proponent','owner_of_record')""",
                (ent_ids, project_id))).fetchone()
            other_projects = row["n"]

        elig, reasons = evaluate_project(filings, units, stage, biz["min_units"], biz["max_units"])
        attrs: dict[str, Any] = {
            "units_proposed": units, "units_confidence": units_conf, "project_types": types, "stage": stage,
            "proposed_cost": float(proposed_cost) if proposed_cost else None, "declared_valuation": declared,
        }
        fin = estimate(attrs, self.settings)
        latest = max(dates) if dates else None
        missing = []
        if units is None:
            missing.append("unit count")
        if not dev:
            missing.append("developer/proponent")
        if not has_contact:
            missing.append("verified contact")
        if not parcel:
            missing.append("parcel id")
        if lat is None:
            missing.append("coordinates")
        if fin["est_loan_low"] is None:
            missing.append("cost basis")
        confidence = "high" if units_conf == "high" and (parcel or lat is not None) and stage else \
            ("medium" if units is not None else "low")
        sc, breakdown = score({**attrs, **fin, "latest_filing_date": latest, "has_verified_contact": has_contact,
                               "has_named_developer": bool(dev),
                               "has_applicant": any(r["role"] in ("applicant", "zba_contact", "owner_of_record") for r in roles),
                               "developer_other_projects": other_projects}, self.settings, date.today())
        if units is None:
            ptype = "mixed_use" if mixed else "unknown"
        elif mixed:
            ptype = "mixed_use"
        elif units == 1:
            ptype = "single_family"
        elif units <= 4:
            ptype = "two_to_four_family"
        else:
            ptype = "multifamily"
        geom_sql = "ST_SetSRID(ST_MakePoint(%(lon)s::float8, %(lat)s::float8), 4326)::geography" \
            if lat is not None and lon is not None else "geom"
        name = (a80 or {}).get("title") or before["name"] or address
        after = await (await conn.execute(f"""
            UPDATE projects SET name=%(name)s, address=%(addr)s, address_norm=%(norm)s,
                address_keys=%(keys)s, parcel_id=%(parcel)s,
                neighborhood=COALESCE(%(nbhd)s, neighborhood), zip=COALESCE(%(zip)s, zip), geom={geom_sql},
                property_type=%(ptype)s, project_types=%(types)s, is_mixed_use=%(mixed)s, units_proposed=%(units)s,
                units_existing=%(ue)s, units_source=%(us)s, units_confidence=%(uc)s, gross_sqft=%(gsf)s,
                retail_sqft=%(rsf)s, proposed_cost=%(cost)s, declared_valuation=%(val)s, stage=%(stage)s,
                stage_rank=%(srank)s, review_status=%(rs)s, lending_category=%(lc)s, est_tdc_low=%(tl)s,
                est_tdc_high=%(th)s, est_loan_low=%(ll)s, est_loan_high=%(lh)s, financing_basis=%(fb)s,
                financing_fit=%(fit)s, eligibility=%(el)s, eligibility_reasons=%(er)s, score=%(score)s,
                score_breakdown=%(sb)s, confidence=%(conf)s, missing_data=%(miss)s, has_contact=%(hc)s,
                developer_entity_id=%(dev)s, first_filing_date=%(ffd)s, latest_filing_date=%(lfd)s,
                project_url=COALESCE(project_url, %(purl)s), description=COALESCE(%(desc)s, description),
                last_activity_at = CASE WHEN latest_filing_date IS DISTINCT FROM %(lfd)s
                                         OR units_proposed IS DISTINCT FROM %(units)s
                                         OR stage IS DISTINCT FROM %(stage)s THEN now() ELSE last_activity_at END,
                updated_at=now()
            WHERE id=%(id)s RETURNING *""", {
            "id": project_id, "name": name, "addr": address, "norm": normalize_address(address),
            "keys": sorted(set(address_keys(address)) | set(before["address_keys"] or [])), "parcel": parcel,
            "nbhd": (a80 or {}).get("neighborhood") or first("neighborhood", ("boston.permit_applications",
                                                                               "boston.records_library", "boston.zba",
                                                                               "boston.building_permits")),
            "zip": first("zip"), "lat": lat, "lon": lon, "ptype": ptype, "types": types, "mixed": mixed,
            "units": units, "ue": units_existing, "us": units_source, "uc": units_conf, "gsf": gross, "rsf": retail,
            "cost": attrs["proposed_cost"], "val": declared, "stage": stage, "srank": rank(stage), "rs": review_status,
            "lc": fin["lending_category"], "tl": fin["est_tdc_low"], "th": fin["est_tdc_high"],
            "ll": fin["est_loan_low"], "lh": fin["est_loan_high"], "fb": jsonb(fin["financing_basis"]),
            "fit": fin["financing_fit"], "el": elig, "er": reasons, "score": sc, "sb": jsonb(breakdown),
            "conf": confidence, "miss": missing, "hc": has_contact, "dev": dev["entity_id"] if dev else None,
            "ffd": min(dates) if dates else None, "lfd": latest,
            "purl": (a80 or {}).get("document_url"),
            "desc": (a80 or {}).get("description"),
        })).fetchone()
        return before, after

    # ------------------------------------------------------------------ events & alerts
    def _alert_decision(self, project: dict, event_type: str, ctx: RunContext) -> tuple[bool, str | None]:
        a = self.settings["alerts"]
        if not ctx.alerts_enabled:
            return False, ctx.mode
        if event_type not in a["event_types"]:
            return False, "event_type_not_alerted"
        if project["eligibility"] == QUALIFIED:
            if not a["notify_qualified"]:
                return False, "qualified_alerts_disabled"
        elif project["eligibility"] == "needs_review":
            if not a["notify_needs_review"]:
                return False, "needs_review"
        else:
            return False, "not_qualified"
        if a.get("min_score") and (project.get("score") or 0) < a["min_score"]:
            return False, "below_min_score"
        if a.get("min_units") and (project.get("units_proposed") or 0) < a["min_units"]:
            return False, "below_min_units"
        return True, None

    async def _insert_event(self, conn, project: dict, filing_id: int | None, event_type: str, summary: str,
                            dedupe_key: str, details: dict, filing_date: date | None, ctx: RunContext,
                            force_suppress: str | None = None) -> dict | None:
        alertable, reason = self._alert_decision(project, event_type, ctx)
        if force_suppress and alertable:
            alertable, reason = False, force_suppress
        row = await (await conn.execute(
            """INSERT INTO project_events (project_id, filing_id, event_type, summary, details, source_filing_date,
                   source_published_at, dedupe_key, alertable, suppressed_reason)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (dedupe_key) DO NOTHING RETURNING *""",
            (project["id"], filing_id, event_type, summary, jsonb(details), filing_date, ctx.source_published_at,
             dedupe_key, alertable, reason))).fetchone()
        if row is None:
            return None
        ctx.stats["events"] += 1
        if alertable:
            await self.enqueue_alert(conn, row, project, filing_id)
            ctx.stats["alerts_queued"] += 1
        return row

    async def _ensure_announcement(self, conn, project: dict, filing_id: int, f: NormalizedFiling,
                                   created: bool, ctx: RunContext) -> bool:
        """Announce a project once, the first time it is qualified (or record it silently during backfill)."""
        if project["eligibility"] != QUALIFIED or project.get("new_project_event_id"):
            return False
        key = f"project:{project['id']}:{'created' if created else 'qualified'}"
        summary = (f"New qualifying project from {f.source_key} ({f.doc_type or f.record_class})" if created
                   else f"Project now qualifies after {f.source_key} {f.record_class} update")
        ev = await self._insert_event(conn, project, filing_id, "new_project", summary, key,
                                      {"source_key": f.source_key, "source_record_id": f.source_record_id,
                                       "record_class": f.record_class, "reasons": project["eligibility_reasons"]},
                                      f.source_filing_date, ctx)
        if ev:
            await conn.execute("UPDATE projects SET new_project_event_id=%s WHERE id=%s", (ev["id"], project["id"]))
            project["new_project_event_id"] = ev["id"]
            return True
        return False

    async def _emit_events(self, conn, f: NormalizedFiling, filing_id: int, old: dict | None, project: dict,
                           created: bool, ctx: RunContext) -> None:
        sk, sid = f.source_key, f.source_record_id
        if f.source_key == "boston.a80_legacy":
            return  # enrichment only — never generates activity events
        announced = await self._ensure_announcement(conn, project, filing_id, f, created, ctx)
        covered = "covered_by_new_project_alert" if announced else None
        dev_scope = bool(set(f.project_types) & DEV_TYPES) and not f.ordinary_work

        if old is None:
            if created and not announced:
                await self._insert_event(conn, project, filing_id, "new_project",
                                         f"New project record ({project['eligibility']}) from {sk}",
                                         f"project:{project['id']}:created", {"source_key": sk}, f.source_filing_date,
                                         ctx, force_suppress="not_yet_qualified")
                return
            if created:
                return
            if f.filing_kind == "developer_filing" or (f.record_class == "permit_application" and dev_scope):
                etype, summary = "new_plan_submission", f"New {f.doc_type or f.record_class} filed"
            elif f.filing_kind == "approval":
                etype, summary = "approval", f"Approval: {f.doc_type or f.status}"
            elif f.record_class == "issued_permit" and dev_scope:
                etype, summary = "permit_issued", f"Issued permit {sid}: {f.doc_type}"
            elif f.filing_kind == "completion":
                etype, summary = "status_changed", f"Certificate of occupancy {sid}"
            else:
                etype, summary = "new_filing", f"Linked {f.record_class.replace('_', ' ')}: {f.doc_type or sid}"
            await self._insert_event(conn, project, filing_id, etype, summary, f"filing:{sk}:{sid}:new",
                                     {"source_key": sk, "source_record_id": sid, "record_class": f.record_class,
                                      "filing_kind": f.filing_kind}, f.source_filing_date, ctx, force_suppress=covered)
            return

        # material change on an existing filing
        if old["units_proposed"] != f.units_proposed and f.units_proposed is not None:
            await self._insert_event(
                conn, project, filing_id, "units_changed",
                f"Unit count revised {old['units_proposed'] if old['units_proposed'] is not None else 'unknown'} → "
                f"{f.units_proposed} ({sk})", f"units:{sk}:{sid}:{old['units_proposed']}->{f.units_proposed}",
                {"old": old["units_proposed"], "new": f.units_proposed}, f.source_filing_date, ctx,
                force_suppress=covered)
        if old["stage"] != f.stage and f.stage:
            if f.stage in ("board_approved", "zoning_approved"):
                etype = "approval"
            elif f.stage == "permit_issued":
                etype = "permit_issued"
            else:
                etype = "status_changed"
            await self._insert_event(conn, project, filing_id, etype,
                                     f"{sk}: status {old['status'] or old['stage']} → {f.status or f.stage}",
                                     f"stage:{sk}:{sid}:{f.stage}", {"old": old["stage"], "new": f.stage},
                                     f.source_filing_date, ctx, force_suppress=covered)
        if f.record_class == "planning_project" and old["source_filing_date"] != f.source_filing_date \
                and f.source_filing_date and (old["source_filing_date"] is None or f.source_filing_date > old["source_filing_date"]):
            await self._insert_event(conn, project, filing_id, "new_plan_submission",
                                     f"New Article 80 filing recorded (last filed date {f.source_filing_date})",
                                     f"a80filed:{sid}:{f.source_filing_date}",
                                     {"old": str(old["source_filing_date"]), "new": str(f.source_filing_date)},
                                     f.source_filing_date, ctx, force_suppress=covered)

    async def enqueue_alert(self, conn, event: dict, project: dict, filing_id: int | None) -> None:
        filing = None
        if filing_id:
            filing = await (await conn.execute(
                "SELECT record_class, doc_type, document_url, source_url FROM filings WHERE id=%s",
                (filing_id,))).fetchone()
        parties = await (await conn.execute(
            """SELECT pe.role, e.name FROM project_entities pe JOIN entities e ON e.id=pe.entity_id
               WHERE pe.project_id=%s ORDER BY pe.id""", (project["id"],))).fetchall()
        subject, body = format_alert(event, project, filing, parties, self.config.dashboard_url)
        next_at = quiet_hours_release(self.settings["alerts"].get("quiet_hours"), datetime.now(timezone.utc))
        for channel in self.config.notify_channels:
            await conn.execute(
                """INSERT INTO notifications (event_id, kind, channel, dedupe_key, subject, body, next_attempt_at)
                   VALUES (%s,'alert',%s,%s,%s,%s,%s) ON CONFLICT (dedupe_key) DO NOTHING""",
                (event["id"], channel, f"alert:{event['id']}:{channel}", subject, body, next_at))


def quiet_hours_release(qh: dict | None, now: datetime) -> datetime:
    """Return now, or the end of the configured quiet-hours window if now falls inside it."""
    if not qh:
        return now
    tz = ZoneInfo(qh.get("tz", "America/New_York"))
    local = now.astimezone(tz)
    sh, sm = map(int, qh["start"].split(":"))
    eh, em = map(int, qh["end"].split(":"))
    start_t, end_t, cur = time(sh, sm), time(eh, em), local.time()
    inside = (start_t <= cur or cur < end_t) if start_t > end_t else (start_t <= cur < end_t)
    if not inside:
        return now
    end_local = datetime.combine(local.date(), end_t, tzinfo=tz)
    if end_local <= local:
        end_local += timedelta(days=1)
    return end_local.astimezone(timezone.utc)


async def reprocess(db: Database, settings: dict, config: Config, source_keys: list[str], batch: int = 2000) -> dict:
    """Re-normalize and re-classify stored raw records after rule changes. Never alerts. Projects left with
    only rejected filings and no analyst activity are removed."""
    from .adapters import registry
    ctx = RunContext(mode="reprocess", alerts_enabled=False)
    pipe = Pipeline(db, settings, config)
    for key in source_keys:
        adapter = registry.get(key)
        last = 0
        while True:
            rows = await db.fetch(
                """SELECT id, source_record_id, payload, source_url, source_filing_date, source_updated_at
                   FROM raw_records WHERE source_key=%s AND id > %s ORDER BY id LIMIT %s""", key, last, batch)
            if not rows:
                break
            last = rows[-1]["id"]
            await pipe.process_page(adapter, [RawRecord(key, r["source_record_id"], r["payload"], r["source_url"],
                                                        r["source_filing_date"], r["source_updated_at"]) for r in rows],
                                    ctx, force=True)
    removed = await db.fetch(
        """DELETE FROM projects p WHERE p.pipeline_status='New' AND p.notes IS NULL
             AND NOT EXISTS (SELECT 1 FROM filings f WHERE f.project_id=p.id AND f.eligibility <> 'rejected'
                             AND f.source_key NOT IN (SELECT key FROM sources WHERE is_enrichment_only))
           RETURNING id""")
    ctx.stats["projects_removed"] = len(removed)
    return ctx.stats
