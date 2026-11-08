import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await q("SELECT id, name, query, created_at FROM saved_searches ORDER BY name"));
}
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.query) return NextResponse.json({ error: "name and query required" }, { status: 400 });
  const path = ["/leads", "/map"].includes(body.query.path) ? body.query.path : "/leads";
  const rows = await q("INSERT INTO saved_searches (name, query) VALUES ($1, $2) RETURNING id",
    [String(body.name).slice(0, 100), JSON.stringify({ qs: String(body.query.qs ?? "").slice(0, 2000), path })]);
  return NextResponse.json(rows[0]);
}
export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await q("DELETE FROM saved_searches WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
}
