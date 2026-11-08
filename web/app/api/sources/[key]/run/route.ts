import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const key = (await ctx.params).key;
  const rows = await q("UPDATE source_state SET next_run_at=now(), circuit_open_until=NULL WHERE source_key=$1 RETURNING source_key", [key]);
  if (!rows.length) return NextResponse.json({ error: "unknown source" }, { status: 404 });
  return NextResponse.redirect(new URL("/health", req.url), 303);
}
