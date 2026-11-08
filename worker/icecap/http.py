"""Polite HTTP client for public data sources.

* per-host rate limiting (minimum spacing between requests) and bounded concurrency
* retries with exponential backoff + jitter on timeouts, 429 and 5xx (honours Retry-After)
* conditional requests (If-None-Match / If-Modified-Since) with 304 handling
* request counting for run metrics
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

log = logging.getLogger(__name__)

# Conservative defaults per host: (min seconds between requests, max concurrent requests)
HOST_LIMITS: dict[str, tuple[float, int]] = {
    "data.boston.gov": (0.5, 2),
    "gis.bostonplans.org": (0.5, 2),
    "gisportal.boston.gov": (0.5, 2),
    "sire.bostonplans.org": (1.0, 1),
    "www.bostonplans.org": (2.0, 1),
    "api.telegram.org": (0.1, 2),
}
DEFAULT_LIMIT = (1.0, 1)


class HostLimiter:
    def __init__(self, min_interval: float, concurrency: int):
        self.min_interval = min_interval
        self.sem = asyncio.Semaphore(concurrency)
        self._lock = asyncio.Lock()
        self._last = 0.0

    async def __aenter__(self):
        await self.sem.acquire()
        async with self._lock:
            wait = self._last + self.min_interval - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last = time.monotonic()
        return self

    async def __aexit__(self, *exc):
        self.sem.release()


class UpstreamError(Exception):
    """Raised when a source cannot be fetched after all retries."""


@dataclass
class FetchResult:
    status: int
    data: Any
    headers: httpx.Headers
    not_modified: bool = False
    url: str = ""


class PoliteClient:
    def __init__(self, user_agent: str, timeout_s: float = 90, max_retries: int = 4,
                 backoff_base: float = 2.0, transport: httpx.AsyncBaseTransport | None = None):
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_s, connect=20),
            headers={"User-Agent": user_agent, "Accept": "application/json"},
            follow_redirects=True,
            transport=transport,
        )
        self._limiters: dict[str, HostLimiter] = {}
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.request_count = 0

    def _limiter(self, url: str) -> HostLimiter:
        host = urlparse(url).hostname or ""
        if host not in self._limiters:
            self._limiters[host] = HostLimiter(*HOST_LIMITS.get(host, DEFAULT_LIMIT))
        return self._limiters[host]

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request(self, method: str, url: str, *, params: dict | None = None,
                      json_body: Any = None, data: Any = None, etag: str | None = None,
                      last_modified: str | None = None, expect_json: bool = True,
                      extra_headers: dict | None = None) -> FetchResult:
        headers = dict(extra_headers or {})
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        attempt = 0
        while True:
            attempt += 1
            try:
                async with self._limiter(url):
                    self.request_count += 1
                    resp = await self._client.request(method, url, params=params, json=json_body,
                                                      data=data, headers=headers)
                if resp.status_code == 304:
                    return FetchResult(304, None, resp.headers, not_modified=True, url=str(resp.url))
                if resp.status_code == 429 or resp.status_code >= 500:
                    raise _Retryable(resp.status_code, resp.headers.get("Retry-After"), resp.text[:300])
                if resp.status_code >= 400:
                    raise UpstreamError(f"{method} {url} -> HTTP {resp.status_code}: {resp.text[:300]}")
                payload = resp.json() if expect_json else resp.text
                return FetchResult(resp.status_code, payload, resp.headers, url=str(resp.url))
            except (_Retryable, httpx.TimeoutException, httpx.TransportError, ValueError) as exc:
                if isinstance(exc, ValueError) and not isinstance(exc, _Retryable) and attempt > 2:
                    raise UpstreamError(f"{url}: invalid JSON response") from exc
                if attempt > self.max_retries:
                    raise UpstreamError(f"{method} {url} failed after {attempt} attempts: {exc!r}") from exc
                delay = self.backoff_base ** attempt + random.uniform(0, 1)
                retry_after = getattr(exc, "retry_after", None)
                if retry_after:
                    try:
                        delay = max(delay, float(retry_after))
                    except ValueError:
                        pass
                delay = min(delay, 120)
                log.warning("retrying %s %s in %.1fs (attempt %d): %r", method, url, delay, attempt, exc)
                await asyncio.sleep(delay)

    async def get_json(self, url: str, params: dict | None = None, **kw) -> FetchResult:
        return await self.request("GET", url, params=params, **kw)


class _Retryable(Exception):
    def __init__(self, status: int, retry_after: str | None, body: str):
        super().__init__(f"HTTP {status}: {body}")
        self.status = status
        self.retry_after = retry_after
