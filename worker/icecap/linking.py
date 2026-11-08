"""Cross-source project linking.

Validated relationships only, in priority order:
1. official Article 80 ProjectID
2. bostonplans.org project page slug (Records Library documents carry the project's page URL)
3. official permit application number (shared by applications, issued permits and ZBA parent_apno)
4. parcel id
5. same street number + street name (ranges expanded), with a 200 m distance check when both have coordinates
6. exact project name (Records Library ↔ Article 80)
"""
from __future__ import annotations

import re
from typing import Any

from .models import NormalizedFiling
from .normalize import address_keys, normalize_address

MAX_LINK_DISTANCE_M = 200


def link_key_for(f: NormalizedFiling) -> str:
    rid = f.related_ids or {}
    if rid.get("a80_project_id"):
        return f"a80:{rid['a80_project_id']}"
    if rid.get("project_slug"):
        return f"slug:{rid['project_slug']}"
    if rid.get("application_number"):
        return f"app:{rid['application_number']}"
    keys = address_keys(f.address)
    if f.parcel_id:
        return f"parcel:{f.parcel_id}:{keys[0] if keys else ''}"
    norm = normalize_address(f.address)
    if norm and keys:
        return f"addr:{norm}"
    return f"src:{f.source_key}:{f.source_record_id}"


async def find_project(conn, f: NormalizedFiling) -> int | None:
    rid = f.related_ids or {}
    if rid.get("a80_project_id"):
        row = await (await conn.execute("SELECT id FROM projects WHERE a80_project_id=%s",
                                        (str(rid["a80_project_id"]),))).fetchone()
        if row:
            return row["id"]
    if f.link_by_official_id_only:
        return None
    if rid.get("project_slug"):
        row = await (await conn.execute("SELECT id FROM projects WHERE project_slug=%s ORDER BY id LIMIT 1",
                                        (rid["project_slug"],))).fetchone()
        if row:
            return row["id"]
    for app_field in ("application_number", "zba_application_number", "boa_apno"):
        app = rid.get(app_field)
        if not app:
            continue
        row = await (await conn.execute(
            """SELECT project_id FROM filings
               WHERE project_id IS NOT NULL AND (related_ids->>'application_number' = %(a)s
                     OR related_ids->>'zba_application_number' = %(a)s OR related_ids->>'boa_apno' = %(a)s)
               LIMIT 1""", {"a": app})).fetchone()
        if row:
            return row["project_id"]
    if f.parcel_id:
        row = await (await conn.execute(
            "SELECT id FROM projects WHERE parcel_id=%s ORDER BY last_activity_at DESC LIMIT 1",
            (f.parcel_id,))).fetchone()
        if row:
            return row["id"]
    keys = address_keys(f.address)
    if keys:
        params: dict[str, Any] = {"keys": keys, "lat": f.lat, "lon": f.lon, "parcel": f.parcel_id,
                                  "maxd": MAX_LINK_DISTANCE_M}
        row = await (await conn.execute(
            """SELECT id FROM projects
               WHERE address_keys && %(keys)s::text[]
                 AND (geom IS NULL OR %(lat)s::float8 IS NULL
                      OR ST_DWithin(geom, ST_SetSRID(ST_MakePoint(%(lon)s::float8, %(lat)s::float8), 4326)::geography, %(maxd)s))
                 AND (parcel_id IS NULL OR %(parcel)s::text IS NULL OR parcel_id = %(parcel)s::text
                      OR a80_project_id IS NOT NULL)
               ORDER BY (a80_project_id IS NOT NULL) DESC, last_activity_at DESC LIMIT 1""", params)).fetchone()
        if row:
            return row["id"]
    if f.record_class == "planning_document" and f.address:
        row = await (await conn.execute(
            "SELECT id FROM projects WHERE lower(name)=lower(%s) ORDER BY (a80_project_id IS NOT NULL) DESC LIMIT 1",
            (f.address,))).fetchone()
        if row:
            return row["id"]
    return None


async def create_project(conn, f: NormalizedFiling, city_id: str) -> tuple[int, bool]:
    rid = f.related_ids or {}
    key = link_key_for(f)
    geom_sql = "ST_SetSRID(ST_MakePoint(%(lon)s::float8, %(lat)s::float8), 4326)::geography" \
        if f.lat is not None and f.lon is not None else "NULL"
    row = await (await conn.execute(
        f"""INSERT INTO projects (city_id, link_key, a80_project_id, name, address, address_norm, address_keys,
                project_slug, parcel_id, neighborhood, zip, geom, project_url, description, first_filing_date,
                latest_filing_date)
            VALUES (%(city)s, %(key)s, %(a80)s, %(name)s, %(addr)s, %(norm)s, %(keys)s, %(slug)s, %(parcel)s,
                %(nbhd)s, %(zip)s, {geom_sql}, %(url)s, %(desc)s, %(fd)s, %(fd)s)
            ON CONFLICT (link_key) DO NOTHING RETURNING id""",
        {"city": city_id, "key": key, "a80": str(rid["a80_project_id"]) if rid.get("a80_project_id") else None,
         "name": f.title if f.record_class == "planning_project" else (f.address or f.title),
         "addr": f.address, "norm": normalize_address(f.address), "keys": address_keys(f.address),
         "slug": rid.get("project_slug"), "parcel": f.parcel_id, "nbhd": f.neighborhood, "zip": f.zip,
         "lat": f.lat, "lon": f.lon, "url": f.project_url, "desc": f.description, "fd": f.source_filing_date},
    )).fetchone()
    if row:
        return row["id"], True
    row = await (await conn.execute("SELECT id FROM projects WHERE link_key=%s", (key,))).fetchone()
    return row["id"], False


async def attach_orphans(conn, project_id: int) -> int:
    """Attach previously unlinked filings that share an official id, parcel or street address."""
    p = await (await conn.execute(
        "SELECT parcel_id, address_keys, a80_project_id, project_slug FROM projects WHERE id=%s",
        (project_id,))).fetchone()
    apps = await (await conn.execute(
        """SELECT DISTINCT related_ids->>'application_number' AS a FROM filings
           WHERE project_id=%s AND related_ids->>'application_number' IS NOT NULL""", (project_id,))).fetchall()
    app_list = [r["a"] for r in apps]
    cur = await conn.execute(
        """UPDATE filings SET project_id=%(pid)s
           WHERE project_id IS NULL AND (
                 (%(parcel)s::text IS NOT NULL AND parcel_id = %(parcel)s::text)
              OR (cardinality(%(keys)s::text[]) > 0 AND address_keys && %(keys)s::text[]
                  AND (parcel_id IS NULL OR %(parcel)s::text IS NULL OR parcel_id = %(parcel)s::text OR %(a80)s::text IS NOT NULL))
              OR (related_ids->>'application_number') = ANY(%(apps)s::text[])
              OR (%(a80)s::text IS NOT NULL AND related_ids->>'a80_project_id' = %(a80)s::text)
              OR (%(slug)s::text IS NOT NULL AND related_ids->>'project_slug' = %(slug)s::text))
             AND (source_key NOT IN (SELECT key FROM sources WHERE is_enrichment_only)
                  OR related_ids->>'a80_project_id' = %(a80)s::text)""",
        {"pid": project_id, "parcel": p["parcel_id"], "keys": p["address_keys"] or [], "apps": app_list,
         "a80": p["a80_project_id"], "slug": p["project_slug"]})
    return cur.rowcount or 0


def entity_kind(name: str) -> str:
    if re.search(r"\b(LLC|L\.L\.C|INC|CORP|TRUST|LP|LLP|COMPANY|DEVELOPMENT|PROPERTIES|REALTY|GROUP|PARTNERS|"
                 r"ASSOCIATES|VENTURES|HOLDINGS|CAPITAL|HOUSING|AUTHORITY|UNIVERSITY|COLLEGE|CDC|FUND)\b",
                 name.upper()):
        return "organization"
    return "unknown"
