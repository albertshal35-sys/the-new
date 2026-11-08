import { q } from "@/lib/db";
import { buildWhere, sortOf, type Filters } from "@/lib/filters";

export const LEAD_COLUMNS = `p.id, p.name, p.address, p.neighborhood, p.parcel_id, p.units_proposed, p.units_confidence,
  p.property_type, p.project_types, p.is_mixed_use, p.stage, p.eligibility, p.eligibility_reasons, p.financing_fit,
  p.est_loan_low, p.est_loan_high, p.declared_valuation, p.score, p.confidence, p.missing_data, p.has_contact,
  p.first_filing_date, p.latest_filing_date, p.first_seen_at, p.pipeline_status, p.is_read, p.lending_category,
  p.project_url, ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lon,
  (SELECT e.name FROM entities e WHERE e.id = p.developer_entity_id) AS developer,
  (SELECT string_agg(DISTINCT e.name, '; ') FROM project_entities pe JOIN entities e ON e.id = pe.entity_id
     WHERE pe.project_id = p.id AND pe.role = 'owner_of_record') AS owner_of_record,
  (SELECT string_agg(DISTINCT e.name, '; ') FROM project_entities pe JOIN entities e ON e.id = pe.entity_id
     WHERE pe.project_id = p.id AND pe.role IN ('applicant','zba_contact')) AS applicants`;

export async function listLeads(f: Filters, limit: number, offset: number) {
  const [where, params] = buildWhere(f);
  const s = sortOf(f);
  const rows = await q(
    `SELECT ${LEAD_COLUMNS} FROM projects p WHERE ${where} ORDER BY ${s.order} LIMIT ${limit + 1} OFFSET ${offset}`,
    params,
  );
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function countLeads(f: Filters) {
  const [where, params] = buildWhere(f);
  const r = await q<{ n: number }>(`SELECT count(*)::int AS n FROM projects p WHERE ${where}`, params);
  return r[0]?.n ?? 0;
}

export async function neighborhoods(): Promise<string[]> {
  const r = await q<{ neighborhood: string }>(
    "SELECT DISTINCT neighborhood FROM projects WHERE neighborhood IS NOT NULL ORDER BY 1",
  );
  return r.map((x) => x.neighborhood);
}
