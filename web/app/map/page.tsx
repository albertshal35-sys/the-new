import { q } from "@/lib/db";
import { buildWhere, parseFilters, toQueryString } from "@/lib/filters";
import { neighborhoods } from "@/lib/leads";
import FilterBar from "@/components/FilterBar";
import MapClient from "@/components/MapClient";
import type { MapPoint } from "@/components/MapView";
import SavedSearches from "@/components/SavedSearches";

export const dynamic = "force-dynamic";

export default async function MapPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const f = parseFilters(await searchParams);
  const [where, params] = buildWhere(f);
  const [rows, nb, missing] = await Promise.all([
    q(`SELECT p.id, ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lon, COALESCE(p.address, p.name) AS address,
              p.units_proposed AS units, p.stage, p.eligibility, p.score, p.financing_fit AS fit
         FROM projects p WHERE ${where} AND p.geom IS NOT NULL ORDER BY p.first_seen_at DESC LIMIT 5000`, params),
    neighborhoods(),
    q<{ n: number }>(`SELECT count(*)::int AS n FROM projects p WHERE ${where} AND p.geom IS NULL`, params),
  ]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3"><h1 className="text-lg font-semibold">Map</h1>
        <span className="text-sm text-slate-500">{rows.length} mapped · {missing[0]?.n ?? 0} without published coordinates</span>
        <span className="ml-auto text-xs flex gap-3"><span className="text-emerald-600">● qualified</span><span className="text-amber-600">● needs review</span><span className="text-slate-400">● rejected</span></span>
      </div>
      <FilterBar f={f} neighborhoods={nb} action="/map" showSort={false} />
      <SavedSearches qs={toQueryString(f)} path="/map" />
      <div className="card overflow-hidden"><MapClient points={rows as MapPoint[]} /></div>
    </div>
  );
}
