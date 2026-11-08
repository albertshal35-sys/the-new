"""Helpers for the City of Boston CKAN portal (data.boston.gov)."""
from __future__ import annotations

from datetime import datetime
from typing import AsyncIterator

from ...http import PoliteClient, UpstreamError
from ...normalize import parse_datetime
from ..base import UpstreamVersion

CKAN = "https://data.boston.gov/api/3/action"


def dataset_url(slug: str) -> str:
    return f"https://data.boston.gov/dataset/{slug}"


async def resource_version(client: PoliteClient, resource_id: str) -> UpstreamVersion:
    r = await client.get_json(f"{CKAN}/resource_show", params={"id": resource_id})
    res = r.data.get("result") or {}
    lm = res.get("last_modified") or res.get("metadata_modified")
    return UpstreamVersion(version=lm, updated_at=parse_datetime(lm),
                           extra={"name": res.get("name"), "datastore_active": res.get("datastore_active")})


def sql_quote(v: str) -> str:
    return "'" + str(v).replace("'", "''") + "'"


async def sql_pages(client: PoliteClient, resource_id: str, where: str, page_size: int = 1000,
                    order_col: str = "_id") -> AsyncIterator[list[dict]]:
    """Keyset-paginate datastore_search_sql over `_id` until exhausted."""
    last_id = 0
    while True:
        sql = (f'SELECT * FROM "{resource_id}" WHERE ({where}) AND "{order_col}" > {last_id} '
               f'ORDER BY "{order_col}" ASC LIMIT {page_size}')
        r = await client.get_json(f"{CKAN}/datastore_search_sql", params={"sql": sql})
        if not r.data.get("success"):
            raise UpstreamError(f"CKAN SQL error: {r.data.get('error')}")
        records = r.data["result"]["records"]
        if not records:
            return
        yield records
        last_id = max(int(rec["_id"]) for rec in records)
        if len(records) < page_size:
            return


def window_dates(start: datetime, end: datetime) -> tuple[str, str]:
    return start.date().isoformat(), end.date().isoformat()
