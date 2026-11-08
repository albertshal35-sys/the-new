"""Value normalization: addresses, money, integers, dates, hashing."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timezone
from typing import Any, Iterable

SUFFIXES = {
    "STREET": "ST", "ST": "ST", "AVENUE": "AVE", "AV": "AVE", "AVE": "AVE", "ROAD": "RD", "RD": "RD",
    "BOULEVARD": "BLVD", "BLVD": "BLVD", "PLACE": "PL", "PL": "PL", "TERRACE": "TER", "TER": "TER",
    "DRIVE": "DR", "DR": "DR", "COURT": "CT", "CT": "CT", "LANE": "LN", "LN": "LN", "SQUARE": "SQ",
    "SQ": "SQ", "PARKWAY": "PKWY", "PKWY": "PKWY", "HIGHWAY": "HWY", "HWY": "HWY", "CIRCLE": "CIR",
    "CIR": "CIR", "WAY": "WAY", "ROW": "ROW", "PARK": "PARK", "WHARF": "WHARF", "PLAZA": "PLZ", "PLZ": "PLZ",
}
DIRECTIONS = {"NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W"}
BOSTON_PLACES = {
    "BOSTON", "DORCHESTER", "ROXBURY", "BRIGHTON", "ALLSTON", "MATTAPAN", "HYDE PARK", "JAMAICA PLAIN",
    "ROSLINDALE", "WEST ROXBURY", "EAST BOSTON", "SOUTH BOSTON", "CHARLESTOWN", "MISSION HILL",
    "READVILLE", "CHESTNUT HILL", "NEWTON", "BROOKLINE",
}
_WS = re.compile(r"\s+")


def clean_str(v: Any) -> str | None:
    if v is None:
        return None
    s = _WS.sub(" ", str(v)).strip()
    return s or None


def parse_int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int,)):
        return v
    if isinstance(v, float):
        return int(v)
    s = re.sub(r"[,\s$]", "", str(v))
    m = re.match(r"^-?\d+(\.\d+)?$", s)
    return int(float(s)) if m else None


def parse_money(v: Any) -> float | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = re.sub(r"[,\s$]", "", str(v))
    try:
        return float(s)
    except ValueError:
        return None


def parse_date(v: Any) -> date | None:
    """Parse ISO dates, US m/d/Y, and epoch-milliseconds (ArcGIS)."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000, tz=timezone.utc).date()
    s = str(v).strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return date(int(m[1]), int(m[2]), int(m[3]))
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        return date(int(m[3]), int(m[1]), int(m[2]))
    return None


def parse_datetime(v: Any) -> datetime | None:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000, tz=timezone.utc)
    s = str(v).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        d = parse_date(s)
        return datetime(d.year, d.month, d.day, tzinfo=timezone.utc) if d else None


def _strip_place(addr: str) -> str:
    a = re.sub(r"\b0\d{4}(-\d{4})?\b", "", addr)          # zip
    a = re.sub(r",?\s*\bMA\b\.?", "", a)
    for place in sorted(BOSTON_PLACES, key=len, reverse=True):
        a = re.sub(rf"\s+{place}\s*$", "", a)
    return a.strip(" ,")


def normalize_address(addr: str | None) -> str | None:
    """Uppercase, strip unit/zip/city, normalise suffixes and directions."""
    if not addr:
        return None
    a = addr.upper().replace("&", " AND ").replace(".", " ").replace("#", " UNIT ")
    a = _WS.sub(" ", a).strip()
    a = a.split(",")[0] if re.match(r"^\d", a) else a
    a = _strip_place(a)
    a = re.sub(r"\b(UNIT|APT|SUITE|STE|FL|FLOOR)\b.*$", "", a).strip()
    tokens = []
    for t in a.split(" "):
        t = t.strip(",")
        if not t:
            continue
        tokens.append(SUFFIXES.get(t, DIRECTIONS.get(t, t)))
    out = " ".join(tokens)
    out = re.sub(r"(\d+)\s*-\s*(\d+)", r"\1-\2", out)
    return out or None


def address_keys(addr: str | None, max_span: int = 40) -> list[str]:
    """Tokens '<number>|<street core>' for every house number in the address (ranges expanded).

    The street core drops the suffix so '90 COMMERCIAL WHARF E ROW' and
    '88-91 COMMERCIAL WHARF' share '90|COMMERCIAL WHARF'.
    """
    norm = normalize_address(addr)
    if not norm:
        return []
    m = re.match(r"^(\d+)([A-Z]?)(?:-(\d+)([A-Z]?))?\s+(.+)$", norm)
    if not m:
        return []
    start = int(m[1])
    end = int(m[3]) if m[3] else start
    street = m[5]
    parts = [p for p in street.split(" ") if p]
    # street core: drop trailing suffix / direction tokens
    core_tokens: list[str] = []
    for p in parts:
        if p in SUFFIXES.values() or p in DIRECTIONS.values():
            if core_tokens:
                break
        core_tokens.append(p)
    core = " ".join(core_tokens) or street
    if end < start or end - start > max_span:
        end = start
    return [f"{n}|{core}" for n in range(start, end + 1)]


def content_hash(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def fingerprint(values: Iterable[Any]) -> str:
    raw = json.dumps(list(values), sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def normalize_entity_name(name: str | None) -> str | None:
    if not name:
        return None
    n = name.upper()
    n = re.sub(r"[.,'\"()]", " ", n)
    n = re.sub(r"\b(L\s*L\s*C|LLC|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LP|L\s*P|LTD|THE)\b", " ", n)
    n = _WS.sub(" ", n).strip()
    return n or None


def changed_fields(old: dict, new: dict) -> dict:
    keys = set(old) | set(new)
    return {k: {"old": old.get(k), "new": new.get(k)} for k in sorted(keys) if old.get(k) != new.get(k)}
