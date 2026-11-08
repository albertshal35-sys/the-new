"""Boston property assessment (owner of record) lookup — enrichment only.

Uses the FY property assessment CKAN resource. The owner of record is labelled as such and is never
presented as the developer or borrower.
"""
from __future__ import annotations

import json

from ...http import PoliteClient
from ...normalize import clean_str, parse_int, parse_money
from .ckan import CKAN, dataset_url

RESOURCE_ID = "ee73430d-96c0-423e-ad21-c4cfb54c8961"
SOURCE_KEY = "boston.property_assessment"
DATASET_URL = dataset_url("property-assessment")


async def lookup_parcel(client: PoliteClient, parcel_id: str) -> dict | None:
    r = await client.get_json(f"{CKAN}/datastore_search", params={
        "resource_id": RESOURCE_ID, "filters": json.dumps({"PID": parcel_id}), "limit": 5})
    recs = (r.data.get("result") or {}).get("records") or []
    if not recs:
        return None
    rec = recs[0]
    mail = ", ".join(x for x in [clean_str(rec.get("MAIL_ADDRESSEE")), clean_str(rec.get("MAIL_STREET_ADDRESS")),
                                 clean_str(rec.get("MAIL_CITY")), clean_str(rec.get("MAIL_STATE")),
                                 clean_str(rec.get("MAIL_ZIP_CODE"))] if x)
    return {
        "parcel_id": parcel_id,
        "owner": clean_str(rec.get("OWNER")),
        "mail_address": mail or None,
        "land_use": clean_str(rec.get("LU_DESC")),
        "res_units": parse_int(rec.get("RES_UNITS")),
        "land_sf": parse_int(rec.get("LAND_SF")),
        "gross_area": parse_int(rec.get("GROSS_AREA")),
        "total_value": parse_money(rec.get("TOTAL_VALUE")),
        "yr_built": parse_int(rec.get("YR_BUILT")),
        "payload": {k: v for k, v in rec.items() if k != "_id"},
        "source_url": DATASET_URL,
    }
