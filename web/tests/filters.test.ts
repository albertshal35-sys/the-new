import { describe, expect, it } from "vitest";
import { buildWhere, parseFilters, toQueryString } from "@/lib/filters";
import { csvEscape } from "@/lib/format";

describe("filters", () => {
  it("defaults to qualified leads and supports 'all'", () => {
    expect(parseFilters({}).eligibility).toBe("qualified");
    expect(parseFilters({ eligibility: "all" }).eligibility).toBeUndefined();
  });

  it("compiles unit buckets and independent date filters to parameterized SQL", () => {
    const [sql, params] = buildWhere(
      parseFilters({ units: "5-20", filed_from: "2026-01-01", seen_from: "2026-10-01", eligibility: "needs_review" }),
    );
    expect(sql).toContain("p.units_proposed BETWEEN $2 AND $3");
    expect(sql).toContain("p.latest_filing_date >= $4");
    expect(sql).toContain("p.first_seen_at >= $5::date");
    expect(params).toEqual(["needs_review", 5, 20, "2026-01-01", "2026-10-01"]);
  });

  it("ignores invalid values instead of injecting them", () => {
    const [sql, params] = buildWhere(parseFilters({ stage: "x'; drop table projects;--", filed_from: "nope", eligibility: "all" }));
    expect(sql).toBe("TRUE");
    expect(params).toEqual([]);
  });

  it("uses offset placeholders when requested", () => {
    const [sql] = buildWhere(parseFilters({ neighborhood: "Dorchester", eligibility: "all" }), 3);
    expect(sql).toBe("p.neighborhood = $3");
  });

  it("round-trips query strings", () => {
    const f = parseFilters({ units: "21-50", contact: "1" });
    expect(toQueryString(f)).toContain("units=21-50");
  });

  it("escapes CSV", () => {
    expect(csvEscape('a "b", c')).toBe('"a ""b"", c"');
    expect(csvEscape(["x", "y"])).toBe("x; y");
    expect(csvEscape(null)).toBe("");
  });
});
