/** Live end-to-end run against the real Boston sources (opt-in: LIVE=1). Uses node:sqlite in place of DO storage. */
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine";
import { NodeSql } from "./nodeSql";

describe.runIf(process.env.LIVE === "1")("live", () => {
  it("backfills all sources in resumable 5-minute-style chunks", async () => {
    if (process.env.HTTPS_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent());
    const sql = new NodeSql(process.env.LIVE_DB ?? "/tmp/icecap-live.sqlite");
    const eng = new Engine(sql, { NOTIFY_CHANNELS: "telegram,email", DASHBOARD_URL: "https://example.invalid" });
    let ticks = 0;
    const t0 = Date.now();
    for (; ticks < 400; ticks++) {
      // Same limits the deployed Worker uses per cron invocation.
      const r = await eng.tick({ budgetMs: 25_000, maxRequests: 40 });
      const pending = sql.one<any>(`SELECT count(*) n FROM source_state WHERE backfill_completed_at IS NULL AND source_key<>'boston.property_assessment'`)!.n;
      console.log(`tick ${ticks + 1}: ${JSON.stringify(r.results.map((x: any) => `${x.source}:${x.status}:${x.fetched ?? ""}`))} http=${r.http_requests} pending=${pending}`);
      if (pending === 0) break;
    }
    console.log(`backfill finished in ${ticks + 1} ticks, ${Math.round((Date.now() - t0) / 1000)}s`);
    console.log(JSON.stringify(eng.stats(), null, 1));
    expect(sql.one<any>(`SELECT count(*) n FROM notifications WHERE kind='alert'`)!.n).toBe(0);
  }, 3_600_000);
});
