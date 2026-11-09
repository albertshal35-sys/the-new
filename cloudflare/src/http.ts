/** Polite fetch: per-host spacing, retries with exponential backoff + jitter on 429/5xx/network errors. */
const HOST_SPACING_MS: Record<string, number> = {
  "data.boston.gov": 500, "gis.bostonplans.org": 500, "gisportal.boston.gov": 500, "sire.bostonplans.org": 1000,
};

export class UpstreamError extends Error {}

export class Http {
  requests = 0;
  private last: Record<string, number> = {};
  constructor(private userAgent: string, private maxRetries = 3, private baseDelayMs = 1500,
              private fetcher: typeof fetch = (...a) => fetch(...a)) {}

  async json(url: string, params?: Record<string, string | number>, init?: RequestInit): Promise<any> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, String(v));
    let attempt = 0;
    for (;;) {
      attempt++;
      const host = u.hostname;
      const wait = (this.last[host] ?? 0) + (HOST_SPACING_MS[host] ?? 1000) - Date.now();
      if (wait > 0) await sleep(wait);
      this.last[host] = Date.now();
      this.requests++;
      let retryAfter = 0;
      try {
        const res = await this.fetcher(u.toString(), {
          ...init, headers: { "User-Agent": this.userAgent, Accept: "application/json", ...(init?.headers ?? {}) },
        });
        if (res.status === 429 || res.status >= 500) {
          retryAfter = Number(res.headers.get("Retry-After") ?? 0) * 1000;
          throw new Retryable(`HTTP ${res.status}`);
        }
        if (!res.ok) throw new UpstreamError(`${u.hostname}${u.pathname} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new Retryable(`invalid JSON from ${u.hostname}`);
        }
      } catch (e) {
        if (e instanceof UpstreamError) throw e;
        if (attempt > this.maxRetries) throw new UpstreamError(`${u.hostname}${u.pathname} failed after ${attempt} attempts: ${String(e)}`);
        await sleep(Math.min(Math.max(this.baseDelayMs * 2 ** (attempt - 1) + Math.random() * 500, retryAfter), 20_000));
      }
    }
  }
}
class Retryable extends Error {}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
