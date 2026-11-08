import { NextRequest } from "next/server";
import { parseFilters } from "@/lib/filters";
import { listLeads } from "@/lib/leads";
import { csvEscape } from "@/lib/format";

export const dynamic = "force-dynamic";
const COLS = ["id", "name", "address", "neighborhood", "parcel_id", "units_proposed", "units_confidence", "property_type",
  "project_types", "stage", "eligibility", "eligibility_reasons", "developer", "owner_of_record", "applicants", "has_contact",
  "declared_valuation", "est_loan_low", "est_loan_high", "financing_fit", "lending_category", "score", "confidence",
  "missing_data", "first_filing_date", "latest_filing_date", "first_seen_at", "pipeline_status", "project_url", "lat", "lon"];

export async function GET(req: NextRequest) {
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const f = parseFilters(sp);
  const { rows } = await listLeads(f, 10000, 0);
  const lines = [COLS.join(",")].concat(rows.map((r) => COLS.map((c) => csvEscape(r[c] instanceof Date ? r[c].toISOString() : r[c])).join(",")));
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="icecap-leads-${new Date().toISOString().slice(0, 10)}.csv"` },
  });
}
