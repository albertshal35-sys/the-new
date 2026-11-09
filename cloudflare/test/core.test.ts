import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { article80, buildingPermits, classifyDocument, permitApplications, recordsLibrary, zba } from "../src/adapters/boston";
import type { Adapter } from "../src/adapters/types";
import { Engine } from "../src/engine";
import { Http } from "../src/http";
import { classifyFiling, DEFAULT_SETTINGS, estimateFinancing, evaluateProject, newFiling, pickUnits, score, type RawRecord } from "../src/logic";
import { dispatchDue, formatAlert, quietHoursRelease } from "../src/notify";
import { newStats, Pipeline, type RunCtx } from "../src/pipeline";
import { migrate } from "../src/schema";
import { addressKeys, detectProjectTypes, extractNamedParties, extractUnits, normalizeAddress, parseDate, parseMoney } from "../src/text";
import { NodeSql } from "./nodeSql";

const FIX = new URL("../../worker/tests/fixtures/", import.meta.url);
const fx = (n: string) => JSON.parse(readFileSync(new URL(n, FIX), "utf8"));
const ckan = (n: string) => fx(n).result.records as any[];
const raw = (a: Adapter, id: string, payload: any): RawRecord => ({ sourceKey: a.meta.key, sourceRecordId: id, payload });
const norm = (a: Adapter, id: string, payload: any) => {
  const f = a.normalize(raw(a, id, payload))!;
  [f.eligibility, f.eligibilityReasons] = classifyFiling(f);
  return f;
};
const permit = (over: any) => norm(buildingPermits, over.permitnumber, { ...ckan("permits_erect.json")[0], ...over });

describe("text extraction", () => {
  it.each([
    ["Proposed construction of 5 story, mixed use structure containing 32 residential units, ground level retail", 32],
    ["One Hundred Seventy Six (176) Residential Units, Retail Space And Parking", 176],
    ["convert an existing one family into a three family (as per plans).", 3],
    ["Change occupancy from three-family to four-family.", 4],
    ["Erect new single family with a one car garage.", 1],
    ["Raze existing structure on separate permit and erect single family dwelling", 1],
    ["Construct a Twenty-two (22) unit mixed use residential building", 22],
    ["approximately 35-45 residential units", 45],
    ["Change occupancy from 171 units to 172 units", 172],
  ])("%s", (t, u) => expect(extractUnits(t).units).toBe(u));
  it.each(["boutique hotel containing approximately 35–45 keys", "Install 3 rooftop units and 2 condensing units", "Confirm occupancy as single family", "", null])(
    "never invents: %s", (t) => expect(extractUnits(t as any).units).toBeNull());
  it("types, parties, addresses, parsers", () => {
    expect(detectProjectTypes("Change occupancy from three-family to four-family. Build a new kitchen")).toEqual(["conversion"]);
    expect(detectProjectTypes("Raze existing garage")).toContain("demolition_only");
    expect(extractNamedParties("US Wharf LLC (the Proponent) proposes to demolish.").map((p) => [p.role, p.name])).toEqual([["proponent", "US Wharf LLC"]]);
    expect(normalizeAddress("196 Havre ST East Boston 02128")).toBe("196 HAVRE ST");
    expect(addressKeys("88-91 Commercial Wharf")).toContain("90|COMMERCIAL");
    expect(addressKeys("90 Commercial Wharf East Row")).toEqual(["90|COMMERCIAL"]);
    expect(parseDate("10/1/2026")).toBe("2026-10-01");
    expect(parseDate(1454457600000)).toBe("2016-02-03");
    expect(parseMoney("$8,274,322.00")).toBe(8274322);
  });
});

describe("adapters on real captured responses", () => {
  const feats = Object.fromEntries(fx("a80_fs_query.json").features.map((f: any) => [f.attributes.project_id, { ...f.attributes, _geometry: f.geometry }]));
  it("Article 80", () => {
    const beach = norm(article80, "5058", feats[5058]);
    expect([beach.unitsProposed, beach.stage, beach.eligibility]).toEqual([15, "under_review", "qualified"]);
    expect(beach.relatedIds.project_slug).toBe("105-beach-street");
    expect(norm(article80, "5059", feats[5059]).eligibilityReasons).toEqual(["units_above_200"]);
    const wharf = norm(article80, "5068", feats[5068]);
    expect(wharf.eligibility).toBe("rejected");
    expect(wharf.people.map((p) => p.name)).toEqual(["US Wharf LLC"]);
  });
  it("issued permits", () => {
    const recs = Object.fromEntries([...ckan("permits_sql.json"), ...ckan("permits_erect.json")].map((r) => [r.permitnumber, r]));
    const n = (id: string) => norm(buildingPermits, id, recs[id]);
    expect(n("SF1885940").eligibility).toBe("rejected");
    expect(n("G1916137").eligibility).toBe("rejected");
    expect(n("COO1404847").recordClass).toBe("certificate_of_occupancy");
    const conv = n("ALT1109288");
    expect([conv.unitsProposed, conv.eligibility]).toEqual([3, "qualified"]);
    const erect = n("ERT1102644");
    expect([erect.unitsProposed, erect.eligibility, erect.declaredValuation, erect.people[0].role]).toEqual([32, "qualified", 8274322, "applicant"]);
  });
  it("regressions: tents, hospital rehab, condo split, unit combination", () => {
    expect(permit({ permitnumber: "SF1", permittypedescr: "Short Form Bldg Permit", worktype: "SPCEVE", occupancytype: "Other", comments: "Erect 50x115 tents on 11/19/26" }).eligibility).toBe("rejected");
    expect(permit({ permitnumber: "A1", permittypedescr: "Long Form/Alteration Permit", worktype: "INTREN", occupancytype: "Other", comments: "Gut renovation of 17,000 sf of existing inpatient unit." }).eligibility).toBe("rejected");
    expect(permit({ permitnumber: "A2", permittypedescr: "Long Form/Alteration Permit", worktype: "CHGOCC", occupancytype: "Multi", comments: "Change occupancy from 171 units to 172 units by separating unit 5801" }).eligibilityReasons).toEqual(["minor_unit_reconfiguration_in_existing_building"]);
    expect(permit({ permitnumber: "A3", permittypedescr: "Long Form/Alteration Permit", worktype: "CHGOCC", occupancytype: "Multi", comments: "combine units 3601 and 3606. Changing two residential units to 1 residential unit." }).eligibility).toBe("rejected");
  });
  it("applications and ZBA", () => {
    const apps = Object.fromEntries(ckan("zrit_sql.json").map((r) => [r["Permit application number"], r]));
    const adds = norm(permitApplications, "ALT1910421", apps.ALT1910421);
    expect([adds.unitsExisting, adds.unitsProposed, adds.eligibility]).toEqual([2, 3, "qualified"]);
    expect(norm(permitApplications, "ALT1911183", apps.ALT1911183).eligibility).toBe("rejected");
    const h = ckan("zba_sql.json").find((r) => r.address.startsWith("196 Havre") && r.parent_apno === "ERT1179726");
    const z = norm(zba, "BOA1916253:ERT1179726", h);
    expect([z.unitsProposed, z.eligibility, z.relatedIds.application_number]).toEqual([5, "qualified", "ERT1179726"]);
  });
  it("Records Library classification", () => {
    expect(classifyDocument("Developer Filing", "Project Notification Form (PNF)")).toEqual(["developer_filing", "planning_filing"]);
    expect(classifyDocument("Community Engagement", "Video")[0]).toBe("community_engagement");
    expect(classifyDocument("Vote", "BPDA Board")).toEqual(["approval", "board_approved"]);
    const it0 = fx("records_library_page1.json").metadataObj[0];
    const f = recordsLibrary.normalize(raw(recordsLibrary, it0.boxMetadata.$parent, { boxMetadata: it0.boxMetadata, shareLink: it0.shareLink }))!;
    expect(f.documentUrl).toMatch(/^https:\/\/bpda\.box\.com\//);
  });
});

describe("financing, scoring, eligibility aggregation, alerts", () => {
  const s = DEFAULT_SETTINGS;
  it("valuation is not the loan; cap is not a rejection", () => {
    const r = estimateFinancing({ units_proposed: 32, project_types: ["new_construction"], stage: null, proposed_cost: null, declared_valuation: 8_274_322 }, s);
    expect(r.financing_basis.method).toBe("declared_construction_valuation");
    expect(r.est_tdc_low!).toBeGreaterThan(8_274_322);
    expect(estimateFinancing({ units_proposed: 190, project_types: ["new_construction"], stage: null, proposed_cost: 140e6, declared_valuation: null }, s).financing_fit).toBe("outside_scope");
    expect(estimateFinancing({ units_proposed: null, project_types: [], stage: null, proposed_cost: null, declared_valuation: null }, s).est_loan_low).toBeNull();
  });
  it("score", () => {
    const [v] = score({ units_proposed: 40, stage: "under_review", financing_fit: "likely", est_loan_high: 2e7, latest_filing_date: new Date().toISOString().slice(0, 10),
      has_verified_contact: true, has_named_developer: true, has_applicant: false, developer_other_projects: 3 }, s, new Date());
    expect(v).toBe(100);
  });
  it("units and project eligibility", () => {
    const base = { units_existing: null, stage: null, eligibility_reasons: [], project_types: [] };
    expect(pickUnits([{ ...base, source_key: "boston.building_permits", record_class: "issued_permit", units_proposed: 30, units_source: "text:x", source_filing_date: "2026-10-01", eligibility: "qualified" },
      { ...base, source_key: "boston.a80_projects", record_class: "planning_project", units_proposed: 28, units_source: "structured:x", source_filing_date: "2026-01-01", eligibility: "qualified" }])[0]).toBe(28);
    const f = [{ ...base, source_key: "boston.permit_applications", record_class: "permit_application", units_proposed: null, units_source: null, source_filing_date: null, eligibility: "needs_review", eligibility_reasons: ["units_unknown"], project_types: ["new_construction"] }];
    expect(evaluateProject(f, 12, null)[0]).toBe("qualified");
    expect(evaluateProject(f, 250, null)).toEqual(["rejected", ["units_above_200"]]);
  });
  it("quiet hours and alert text", () => {
    const qh = { start: "22:00", end: "07:00", tz: "America/New_York" };
    expect(quietHoursRelease(qh, new Date("2026-11-08T04:00:00Z")).toISOString()).toBe("2026-11-08T12:00:00.000Z");
    const noon = new Date("2026-11-08T17:00:00Z");
    expect(quietHoursRelease(qh, noon)).toEqual(noon);
    const { body } = formatAlert({ event_type: "new_project", summary: "x", source_filing_date: "2026-10-30", detected_at: "2026-11-08T15:00:00Z" },
      { id: 7, address: "105 Beach Street", neighborhood: "Leather District", units_proposed: null, project_types: '["conversion"]', stage: "under_review",
        financing_fit: "uncertain", confidence: "low", missing_data: '["unit count"]' }, null, [{ role: "applicant", name: "Jane Doe" }], "https://x");
    for (const s2 of ["NEW DEVELOPMENT FILING", "105 Beach Street / Leather District", "Not published. Named: Jane Doe (applicant)", "Residential units: UNKNOWN",
      "Stage: Under Article 80 review", "Source filing date: 2026-10-30", "Missing: unit count", "https://x/leads/7"]) expect(body).toContain(s2);
  });
});

// ---------------------------------------------------------------- database integration
function setup() {
  const sql = new NodeSql();
  migrate(sql);
  const eng = new Engine(sql, { NOTIFY_CHANNELS: "telegram,email", DASHBOARD_URL: "https://dash" });
  eng.init();
  return { sql, eng, pipe: new Pipeline(sql, DEFAULT_SETTINGS, { channels: ["telegram", "email"], dashboardUrl: "https://dash" }) };
}
const ctx = (mode = "incremental"): RunCtx => ({ mode, alertsEnabled: mode !== "backfill", publishedAt: "2026-11-07T23:02:06Z", stats: newStats() });
const a80Raws = () => fx("a80_fs_query.json").features.map((f: any) => raw(article80, String(f.attributes.project_id), { ...f.attributes, _geometry: f.geometry }));
const count = (sql: NodeSql, t: string, w = "1=1") => sql.one<{ n: number }>(`SELECT count(*) n FROM ${t} WHERE ${w}`)!.n;

describe("pipeline + storage", () => {
  it("backfill records silently", () => {
    const { sql, pipe } = setup();
    const c = ctx("backfill");
    pipe.processPage(article80, a80Raws(), c);
    expect(c.stats.inserted).toBe(3);
    expect(count(sql, "notifications")).toBe(0);
    expect(count(sql, "project_events", "alertable=1")).toBe(0);
    expect(sql.one<any>(`SELECT eligibility, units_proposed, new_project_event_id FROM projects WHERE a80_project_id='5058'`)).toMatchObject({ eligibility: "qualified", units_proposed: 15 });
    expect(sql.one<any>(`SELECT new_project_event_id FROM projects WHERE a80_project_id='5058'`).new_project_event_id).not.toBeNull();
  });
  it("alerts once; re-import is silent; material change alerts separately; non-material does not", () => {
    const { sql, pipe } = setup();
    pipe.processPage(article80, a80Raws(), ctx());
    expect(count(sql, "notifications")).toBe(2);
    expect(sql.one<any>(`SELECT body FROM notifications LIMIT 1`).body).toContain("NEW DEVELOPMENT FILING");
    const c2 = ctx();
    pipe.processPage(article80, a80Raws(), c2);
    expect([c2.stats.unchanged, c2.stats.events]).toEqual([3, 0]);
    const first = sql.one<any>(`SELECT first_seen_at FROM filings WHERE source_record_id='5058'`).first_seen_at;
    const changed = a80Raws();
    changed.find((r: RawRecord) => r.sourceRecordId === "5058").payload.total_residential_units = 18;
    pipe.processPage(article80, changed, ctx());
    expect(sql.one<any>(`SELECT summary, alertable FROM project_events WHERE event_type='units_changed'`)).toMatchObject({ alertable: 1, summary: expect.stringContaining("15 → 18") });
    expect(count(sql, "notifications")).toBe(4);
    expect(sql.one<any>(`SELECT version FROM raw_records WHERE source_record_id='5058'`).version).toBe(2);
    expect(sql.one<any>(`SELECT first_seen_at FROM filings WHERE source_record_id='5058'`).first_seen_at).toBe(first);
    const desc = a80Raws();
    const d = desc.find((r: RawRecord) => r.sourceRecordId === "5058");
    d.payload.total_residential_units = 18;
    d.payload.description += " ";
    const c4 = ctx();
    pipe.processPage(article80, desc, c4);
    expect([c4.stats.changed, c4.stats.events]).toEqual([1, 0]);
  });
  it("links issued permit to ZBA appeal by application number; rejected permits never create projects", () => {
    const { sql, pipe } = setup();
    const h = ckan("zba_sql.json").filter((r) => r.address.startsWith("196 Havre"));
    pipe.processPage(zba, h.map((r) => raw(zba, `${r.boa_apno}:${r.parent_apno}`, r)), ctx("backfill"));
    pipe.processPage(buildingPermits, [raw(buildingPermits, "ERT1179726", { ...ckan("permits_erect.json")[0], permitnumber: "ERT1179726", address: "196 Havre ST" })], ctx());
    const rows = sql.all<any>(`SELECT project_id FROM filings WHERE application_number='ERT1179726'`);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.project_id)).size).toBe(1);
    expect(count(sql, "project_events", "event_type='permit_issued'")).toBe(1);
    const before = count(sql, "projects");
    const trade = ckan("permits_sql.json").filter((r) => ["SF1885940", "G1916137"].includes(r.permitnumber));
    pipe.processPage(buildingPermits, trade.map((r) => raw(buildingPermits, r.permitnumber, r)), ctx());
    expect(count(sql, "projects")).toBe(before);
  });
  it("dispatcher: mocked never marks alerted; retries then dead-letters", async () => {
    const { sql, pipe } = setup();
    pipe.processPage(article80, a80Raws(), ctx());
    const failing = { send: async () => { throw new Error("smtp down"); } };
    const mock = { send: async () => ({ mocked: true, id: "mock" }) };
    expect(await dispatchDue(sql, { telegram: mock, email: failing })).toMatchObject({ mocked: 1, failed: 1 });
    expect(count(sql, "project_events", "alerted_at IS NOT NULL")).toBe(0);
    for (let i = 0; i < 8; i++) { sql.run(`UPDATE notifications SET next_attempt_at='2000-01-01' WHERE status='failed'`); await dispatchDue(sql, { email: failing }); }
    expect(sql.one<any>(`SELECT status, attempts FROM notifications WHERE channel='email'`)).toMatchObject({ status: "dead", attempts: 6 });
    sql.run(`UPDATE notifications SET status='pending', attempts=0, next_attempt_at='2000-01-01' WHERE channel='email'`);
    await dispatchDue(sql, { email: { send: async () => ({ mocked: false, id: "42" }) } });
    expect(count(sql, "project_events", "alerted_at IS NOT NULL")).toBe(1);
  });
  it("reprocess re-applies rules without alerts", () => {
    const { sql, eng, pipe } = setup();
    pipe.processPage(article80, a80Raws(), ctx("backfill"));
    sql.run(`INSERT INTO settings (key, value, updated_at) VALUES ('business', '{"max_units": 10}', '')`);
    eng.reprocess("boston.a80_projects", 0);
    expect(sql.one<any>(`SELECT eligibility FROM projects WHERE a80_project_id='5058'`).eligibility).toBe("rejected");
    sql.run(`DELETE FROM settings`);
    eng.reprocess("boston.a80_projects", 0);
    expect(sql.one<any>(`SELECT eligibility FROM projects WHERE a80_project_id='5058'`).eligibility).toBe("qualified");
    expect(count(sql, "notifications")).toBe(0);
  });
});

describe("runner", () => {
  function fakeAdapter(pages: RawRecord[][], opts: { version?: () => string; fail?: () => boolean } = {}): Adapter & { calls: any[] } {
    const calls: any[] = [];
    return {
      calls,
      meta: { ...zba.meta },
      async checkUpstream(h) { h.requests++; if (opts.fail?.()) throw new Error("boom"); return { version: opts.version?.() ?? "v1", updatedAt: "2026-11-08T00:00:00Z" }; },
      async fetchPage(h, c) { h.requests++; calls.push(c); const i = Number(c.cursor?.i ?? 0); return { records: pages[i] ?? [], nextCursor: i + 1 < pages.length ? { i: i + 1 } : null }; },
      normalize: zba.normalize.bind(zba),
    };
  }
  const zbaRows = () => ckan("zba_sql.json").map((r) => raw(zba, `${r.boa_apno}:${r.parent_apno}`, r));
  const budget = (eng: Engine, maxReq = 100) => ({ deadline: Date.now() + 60_000, maxReq, http: new Http("t") });

  it("resumes a backfill across chunks, then skips unchanged upstream, then circuit-breaks", async () => {
    const { sql, eng } = setup();
    const rows = zbaRows();
    let version = "v1", fail = false;
    const a = fakeAdapter([rows.slice(0, 4), rows.slice(4, 8), rows.slice(8)], { version: () => version, fail: () => fail });
    // budget of 2 requests: upstream check + 1 page → run stays in progress
    let r = await eng.runSource(a, { ...budget(eng), maxReq: 2 }, "backfill");
    expect(r.status).toBe("in_progress");
    expect(sql.one<any>(`SELECT run_cursor FROM source_state WHERE source_key='boston.zba'`).run_cursor).toBe('{"i":1}');
    r = await eng.runSource(a, budget(eng));
    expect(r.status).toBe("success");
    expect(sql.one<any>(`SELECT backfill_completed_at, run_mode FROM source_state WHERE source_key='boston.zba'`).backfill_completed_at).not.toBeNull();
    expect(count(sql, "raw_records")).toBe(rows.length);
    expect(sql.one<any>(`SELECT chunks, fetched FROM ingestion_runs WHERE mode='backfill'`)).toMatchObject({ chunks: 2, fetched: rows.length });
    expect(count(sql, "notifications")).toBe(0);
    r = await eng.runSource(a, budget(eng));
    expect(r.status).toBe("unchanged");
    version = "v2";
    r = await eng.runSource(a, budget(eng));
    expect([r.status, r.mode, r.unchanged]).toEqual(["success", "incremental", rows.length]);
    fail = true;
    for (let i = 0; i < 5; i++) await eng.runSource(a, budget(eng));
    expect(sql.one<any>(`SELECT consecutive_failures, circuit_open_until, last_error FROM source_state WHERE source_key='boston.zba'`))
      .toMatchObject({ consecutive_failures: 5, circuit_open_until: expect.any(String), last_error: expect.stringContaining("boom") });
  });
  it("rolling 365-day window and adaptive polling", () => {
    const { eng } = setup();
    const a = fakeAdapter([]);
    expect(eng.chooseMode({ stats: "{}" }, a, Date.now())).toBe("backfill");
    expect(eng.nextInterval({ current_interval_s: 1200, stats: "{}" }, a, true, Date.now())).toBe(300);
    expect(eng.nextInterval({ current_interval_s: 300, stats: "{}" }, a, false, Date.UTC(2026, 10, 8, 3))).toBe(450);
    expect(eng.nextInterval({ current_interval_s: 3000, stats: '{"publish_hours_utc":[12]}' }, a, false, Date.UTC(2026, 10, 8, 12))).toBe(300);
  });
});

describe("misc", () => {
  it("newFiling defaults", () => expect(newFiling({ sourceKey: "x", sourceRecordId: "1", recordClass: "zoning_appeal", filingKind: "appeal" }).projectTypes).toEqual([]));
});
