/** Cloudflare Worker entry: password-protected dashboard + 5-minute cron, backed by one SQLite Durable Object. */
import { DurableObject } from "cloudflare:workers";
import { ADAPTERS } from "./adapters/boston";
import { Engine, type EngineEnv } from "./engine";
import { DurableSql } from "./sql";
import { handle } from "./ui";

export interface Env extends EngineEnv {
  STORE: DurableObjectNamespace<IceCapStore>;
  DASHBOARD_PASSWORD?: string;
}

export class IceCapStore extends DurableObject<Env> {
  private engine: Engine;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.engine = new Engine(new DurableSql(ctx.storage), env);
    ctx.blockConcurrencyWhile(async () => this.engine.init());
  }

  /** Called by the cron trigger every 5 minutes. */
  async tick(): Promise<string> {
    return JSON.stringify(await this.engine.tick());
  }

  async fetch(req: Request): Promise<Response> {
    return handle(this.engine, req, {
      reprocess: async () => {
        await this.ctx.storage.put("reprocess", { sources: ADAPTERS.map((a) => a.meta.key), afterId: 0 });
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return "Re-applying rules in the background (chunks of 3,000 records). This never sends alerts.";
      },
    });
  }

  /** Background re-processing after rule changes, chunked so each alarm stays within platform limits. */
  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<{ sources: string[]; afterId: number }>("reprocess");
    if (!job || !job.sources.length) return;
    const r = this.engine.reprocess(job.sources[0], job.afterId);
    if (r.nextAfterId === null) job.sources.shift(), (job.afterId = 0);
    else job.afterId = r.nextAfterId;
    if (job.sources.length) {
      await this.ctx.storage.put("reprocess", job);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    } else await this.ctx.storage.delete("reprocess");
  }
}

function store(env: Env) {
  return env.STORE.get(env.STORE.idFromName("boston"));
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (!env.DASHBOARD_PASSWORD) {
      return new Response("IceCap is deployed but the dashboard is locked: set a password with `npx wrangler secret put DASHBOARD_PASSWORD`.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const auth = req.headers.get("authorization") ?? "";
    let ok = false;
    if (auth.startsWith("Basic ")) {
      try {
        const decoded = atob(auth.slice(6));
        ok = timingSafeEqual(decoded.slice(decoded.indexOf(":") + 1), env.DASHBOARD_PASSWORD);
      } catch { ok = false; }
    }
    if (!ok) return new Response("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="IceCap", charset="UTF-8"' } });
    // Basic-auth credentials are sent cross-site, so reject state-changing requests from other origins.
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.get("origin") ?? req.headers.get("referer");
      if (!origin || new URL(origin).host !== url.host) return new Response("Cross-origin request blocked", { status: 403 });
    }
    return store(env).fetch(req);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(store(env).tick().then((r: string) => console.log(r)));
  },
} satisfies ExportedHandler<Env>;
