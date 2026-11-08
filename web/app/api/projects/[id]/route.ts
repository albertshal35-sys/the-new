import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { PIPELINE } from "@/lib/filters";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const body = await req.json().catch(() => ({}));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT pipeline_status FROM projects WHERE id=$1 FOR UPDATE", [id]);
    if (!cur.rows[0]) { await client.query("ROLLBACK"); return NextResponse.json({ error: "not found" }, { status: 404 }); }
    if (typeof body.pipeline_status === "string") {
      if (!PIPELINE.includes(body.pipeline_status)) { await client.query("ROLLBACK"); return NextResponse.json({ error: "bad status" }, { status: 400 }); }
      if (body.pipeline_status !== cur.rows[0].pipeline_status) {
        await client.query("UPDATE projects SET pipeline_status=$1, is_read=true WHERE id=$2", [body.pipeline_status, id]);
        await client.query("INSERT INTO pipeline_history (project_id, from_status, to_status, note) VALUES ($1,$2,$3,$4)",
          [id, cur.rows[0].pipeline_status, body.pipeline_status, body.note ?? null]);
      }
    }
    if (typeof body.is_read === "boolean") await client.query("UPDATE projects SET is_read=$1 WHERE id=$2", [body.is_read, id]);
    if (typeof body.notes === "string") await client.query("UPDATE projects SET notes=$1 WHERE id=$2", [body.notes.slice(0, 10000), id]);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
