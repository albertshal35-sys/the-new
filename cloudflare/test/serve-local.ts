/** Local preview: serves the dashboard (src/ui.ts) from a node:sqlite database built by `LIVE=1 vitest run test/live.test.ts`. */
import { createServer } from "node:http";
import { Engine } from "../src/engine";
import { handle } from "../src/ui";
import { NodeSql } from "./nodeSql";

const eng = new Engine(new NodeSql(process.env.LIVE_DB ?? "/tmp/icecap-live.sqlite"), {});
eng.init();
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const r = await handle(eng, new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers as any,
    body: req.method === "POST" ? Buffer.concat(chunks) : undefined }), { reprocess: async () => "not available in preview" });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(Number(process.env.PORT ?? 8788), () => console.log("preview on", process.env.PORT ?? 8788));
