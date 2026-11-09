/** Normalization + conservative extraction from official text. Never invents values: no explicit statement → null. */

// ---------------------------------------------------------------- values
export function cleanStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s || null;
}
export function parseIntLoose(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  const s = String(v).replace(/[,\s$]/g, "");
  return /^-?\d+(\.\d+)?$/.test(s) ? Math.trunc(Number(s)) : null;
}
export function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[,\s$]/g, ""));
  return Number.isFinite(n) ? n : null;
}
/** ISO date (YYYY-MM-DD) from ISO strings, US m/d/Y, or epoch milliseconds. */
export function parseDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return new Date(v).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}
export function parseDateTime(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return new Date(v).toISOString();
  const s = String(v).trim();
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) || !/T/.test(s) ? s : s + "Z");
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  const day = parseDate(s);
  return day ? `${day}T00:00:00.000Z` : null;
}

// ---------------------------------------------------------------- addresses
const SUFFIXES: Record<string, string> = {
  STREET: "ST", ST: "ST", AVENUE: "AVE", AV: "AVE", AVE: "AVE", ROAD: "RD", RD: "RD", BOULEVARD: "BLVD", BLVD: "BLVD",
  PLACE: "PL", PL: "PL", TERRACE: "TER", TER: "TER", DRIVE: "DR", DR: "DR", COURT: "CT", CT: "CT", LANE: "LN", LN: "LN",
  SQUARE: "SQ", SQ: "SQ", PARKWAY: "PKWY", PKWY: "PKWY", HIGHWAY: "HWY", HWY: "HWY", CIRCLE: "CIR", CIR: "CIR",
  WAY: "WAY", ROW: "ROW", PARK: "PARK", WHARF: "WHARF", PLAZA: "PLZ", PLZ: "PLZ",
};
const DIRECTIONS: Record<string, string> = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W" };
const SUFFIX_VALUES = new Set(Object.values(SUFFIXES));
const DIRECTION_VALUES = new Set(Object.values(DIRECTIONS));
const PLACES = ["WEST ROXBURY", "JAMAICA PLAIN", "EAST BOSTON", "SOUTH BOSTON", "MISSION HILL", "CHESTNUT HILL",
  "HYDE PARK", "DORCHESTER", "ROXBURY", "BRIGHTON", "ALLSTON", "MATTAPAN", "ROSLINDALE", "CHARLESTOWN", "READVILLE",
  "NEWTON", "BROOKLINE", "BOSTON"];

export function normalizeAddress(addr: string | null | undefined): string | null {
  if (!addr) return null;
  let a = addr.toUpperCase().replace(/&/g, " AND ").replace(/\./g, " ").replace(/#/g, " UNIT ").replace(/\s+/g, " ").trim();
  if (/^\d/.test(a)) a = a.split(",")[0];
  a = a.replace(/\b0\d{4}(-\d{4})?\b/g, "").replace(/,?\s*\bMA\b/g, "").trim().replace(/[ ,]+$/, "");
  for (const p of PLACES) a = a.replace(new RegExp(`\\s+${p}\\s*$`), "");
  a = a.replace(/\b(UNIT|APT|SUITE|STE|FL|FLOOR)\b.*$/, "").trim();
  const out = a.split(" ").map((t) => t.replace(/,/g, "")).filter(Boolean).map((t) => SUFFIXES[t] ?? DIRECTIONS[t] ?? t).join(" ");
  return out.replace(/(\d+)\s*-\s*(\d+)/, "$1-$2") || null;
}

/** '<number>|<street core>' for every house number (ranges expanded, capped). */
export function addressKeys(addr: string | null | undefined, maxSpan = 40): string[] {
  const norm = normalizeAddress(addr);
  if (!norm) return [];
  const m = norm.match(/^(\d+)([A-Z]?)(?:-(\d+)([A-Z]?))?\s+(.+)$/);
  if (!m) return [];
  const start = Number(m[1]);
  let end = m[3] ? Number(m[3]) : start;
  const core: string[] = [];
  for (const p of m[5].split(" ").filter(Boolean)) {
    if ((SUFFIX_VALUES.has(p) || DIRECTION_VALUES.has(p)) && core.length) break;
    core.push(p);
  }
  const street = core.join(" ") || m[5];
  if (end < start || end - start > maxSpan) end = start;
  const out: string[] = [];
  for (let n = start; n <= end; n++) out.push(`${n}|${street}`);
  return out;
}

export function normalizeEntityName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toUpperCase().replace(/[.,'"()]/g, " ")
    .replace(/\b(L\s*L\s*C|LLC|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LP|L\s*P|LTD|THE)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  return n || null;
}

export function entityKind(name: string): string {
  return /\b(LLC|L\.L\.C|INC|CORP|TRUST|LP|LLP|COMPANY|DEVELOPMENT|PROPERTIES|REALTY|GROUP|PARTNERS|ASSOCIATES|VENTURES|HOLDINGS|CAPITAL|HOUSING|AUTHORITY|UNIVERSITY|COLLEGE|CDC|FUND)\b/.test(name.toUpperCase())
    ? "organization" : "unknown";
}

// ---------------------------------------------------------------- hashing
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
/** Fast 64-bit FNV-1a hash (hex) — content fingerprinting, not security. */
export function hash(v: unknown): string {
  const s = typeof v === "string" ? v : stableStringify(v);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0"));
}
export function changedFields(oldO: Record<string, unknown>, newO: Record<string, unknown>) {
  const out: Record<string, { old: unknown; new: unknown }> = {};
  for (const k of new Set([...Object.keys(oldO), ...Object.keys(newO)])) {
    if (stableStringify(oldO[k]) !== stableStringify(newO[k])) out[k] = { old: oldO[k], new: newO[k] };
  }
  return out;
}

// ---------------------------------------------------------------- units
const NUM_WORDS: Record<string, number> = {
  one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const WORD_NUM = "(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\\s-]?(?:one|two|three|four|five|six|seven|eight|nine)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)";
const NUM = `(?:\\d{1,4}|${WORD_NUM})`;
const UNIT_NOUN = "(?:units?|apartments?|condominiums?|condos?|townhouses?|townhomes?|dwellings?|rowhouses?)";
const UNIT_QUAL = "(?:new|residential|dwelling|housing|rental|condominium|condo|apartment|affordable|market[- ]rate|income[- ]restricted|homeownership|ownership|live[- ]work|for[- ]sale)";
const UNIT_RE = new RegExp(
  `(?<num>${NUM})(?:\\s*\\((?<paren>\\d{1,4})\\))?(?:\\s*(?:-|–|to)\\s*(?<hi>\\d{1,4}))?[\\s-]+(?:${UNIT_QUAL}[\\s-]+){0,3}(?<noun>${UNIT_NOUN})\\b`, "gi");
const NON_DWELLING_CONTEXT = /(rooftop|roof top|condens|hvac|a\/c|\bac\b|heat pump|mini[- ]?split|split|storage|parking|rtu|exhaust|air handl|handling|fan coil|pthp|ptac|kitchen|furnace|boiler|signage|sign|solar|elevator|retail|commercial|office|keys|beds?)\s*$/i;
const FAMILY_TARGET_RE = new RegExp(`\\b(?:to|into)\\s+(?:an?\\s+)?(?<num>${NUM}|single)[\\s-]*(?:family|fam)\\b`, "i");
const FAMILY_FROM_RE = new RegExp(`\\bfrom\\s+(?:an?\\s+)?(?<num>${NUM}|single)[\\s-]*(?:family|fam)\\b`, "i");
const FAMILY_RE = new RegExp(`\\b(?<num>${NUM}|single)[\\s-]*(?:family|fam)\\b`, "gi");
const FROM_TO_UNITS_RE = new RegExp(
  `\\b(?:from\\s+)?(?<a>${NUM})\\s+(?:residential\\s+|dwelling\\s+)?units?\\s+(?:in)?to\\s+(?<b>${NUM})\\s+(?:residential\\s+|dwelling\\s+)?units?\\b`, "i");
const UNIT_COMBINATION_RE = /\b(combin(e|ing|ation of) (two |2 )?(residential |dwelling )?units|merg(e|ing) (two |2 )?units)\b/i;

export function wordToInt(tok: string): number | null {
  const t = tok.toLowerCase().trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (t in NUM_WORDS) return NUM_WORDS[t];
  const parts = t.split(/[\s-]+/);
  if (parts.length === 2 && parts[0] in NUM_WORDS && parts[1] in NUM_WORDS) return NUM_WORDS[parts[0]] + NUM_WORDS[parts[1]];
  return null;
}

export interface UnitsResult { units: number | null; existing: number | null; isRange: boolean; evidence: string | null; method: string | null }

export function extractUnits(text: string | null | undefined): UnitsResult {
  const none: UnitsResult = { units: null, existing: null, isRange: false, evidence: null, method: null };
  if (!text) return none;
  const t = text.replace(/\n/g, " ");
  const ft = t.match(FROM_TO_UNITS_RE);
  if (ft?.groups) {
    const a = wordToInt(ft.groups.a), bb = wordToInt(ft.groups.b);
    if (a !== null && bb !== null) return { units: bb, existing: a, isRange: false, evidence: ft[0], method: "explicit_unit_change" };
  }
  const cands: { pri: number; n: number; range: boolean; ev: string }[] = [];
  for (const m of t.matchAll(UNIT_RE)) {
    const g = m.groups!;
    const start = m.index ?? 0;
    if (NON_DWELLING_CONTEXT.test(t.slice(Math.max(0, start - 30), start))) continue;
    let n = g.paren ? Number(g.paren) : wordToInt(g.num);
    if (n === null) continue;
    const range = Boolean(g.hi);
    if (range) n = Math.max(n, Number(g.hi));
    if (n <= 0 || n > 5000) continue;
    const noun = g.noun.toLowerCase();
    const after = t.slice(start + m[0].length, start + m[0].length + 25).toLowerCase();
    if (noun.startsWith("unit") && /^\s*(of|for)\s+(parking|storage|retail|commercial)/.test(after)) continue;
    const qualified = /residential|dwelling|housing|rental|condo|apartment|homeownership/i.test(m[0]) ||
      /^(apartment|condo|townho|dwelling|rowhouse)/.test(noun);
    cands.push({ pri: qualified ? 2 : 1, n, range, ev: m[0].trim() });
  }
  let existing: number | null = null;
  const fm = t.match(FAMILY_FROM_RE);
  if (fm?.groups) existing = fm.groups.num.toLowerCase() === "single" ? 1 : wordToInt(fm.groups.num);
  if (cands.length) {
    const top = Math.max(...cands.map((c) => c.pri));
    const best = cands.filter((c) => c.pri === top).reduce((a, c) => (c.n > a.n ? c : a));
    return { units: best.n, existing, isRange: best.range, evidence: best.ev, method: "explicit_unit_count" };
  }
  let tm = t.match(FAMILY_TARGET_RE);
  if (tm && /\bconfirm/i.test(t.slice(Math.max(0, (tm.index ?? 0) - 40), tm.index))) tm = null;
  if (tm?.groups) {
    const n = tm.groups.num.toLowerCase() === "single" ? 1 : wordToInt(tm.groups.num);
    if (n) return { units: n, existing, isRange: false, evidence: tm[0], method: "family_conversion_target" };
  }
  for (const m of t.matchAll(FAMILY_RE)) {
    const s = m.index ?? 0;
    const ctx = t.slice(Math.max(0, s - 60), s + m[0].length + 45).toLowerCase();
    const near = t.slice(Math.max(0, s - 14), s).toLowerCase();
    if (/erect|construct|new|build|proposed/.test(ctx) && !/existing|confirm|legal/.test(near)) {
      const n = m.groups!.num.toLowerCase() === "single" ? 1 : wordToInt(m.groups!.num);
      if (n) return { units: n, existing, isRange: false, evidence: m[0], method: "new_family_dwelling" };
    }
  }
  return { ...none, existing };
}

// ---------------------------------------------------------------- project types / signals
const PT: Record<string, RegExp> = {
  new_construction: /\b(erect(ion)?\b|ground[- ]up|new construction|construct\w*\b[^.;]{0,60}\b(building|structure|dwelling|residence|townho\w*|rowhouse\w*|units?|single[- ]family|two[- ]family|three[- ]family|multi[- ]?family)\b|build (an? )?new [^.;]{0,30}\b(building|structure|dwelling|home|house|residence|townho\w*)\b|new (\d+[\s-]*(story|storey) )?(residential|multi[- ]?family|mixed[- ]use) (building|structure|development|project)|new (single|two|three|four)[\s-]family)/i,
  demolition_rebuild: /\b(raze|demolish|demolition|tear down)\b/i,
  conversion: /\b(convert|conversion|change (of )?occupancy|change (of )?use|adaptive(ly)? re-?use|from (an? )?\w+[\s-]family to|from (commercial|office|retail|industrial|church|school))/i,
  substantial_rehab: /\b(gut (rehab|renovation)|gut[- ]renovat|substantial(ly)? (rehab|renovat|reconstruct)|full(y)? renovat|complete(ly)? renovat|major renovation|rehabilitat(e|ion) of (the )?(existing )?(building|structure)|total renovation|down to the studs)/i,
  addition: /\b(addition|dormer|add (an? )?(new )?(\w+ )?(story|stories|floor|level)|vertical expansion)\b/i,
  mixed_use: /\b(mixed[- ]use|ground[- ]floor (retail|commercial|restaurant)|first[- ]floor (retail|commercial|restaurant)|retail (space|use)|commercial (space|unit))\b/i,
};
export function detectProjectTypes(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = Object.keys(PT).filter((k) => PT[k].test(text));
  const i = found.indexOf("demolition_rebuild");
  if (i >= 0 && !found.includes("new_construction")) {
    found.splice(i, 1);
    found.push("demolition_only");
  }
  return found;
}
const RESIDENTIAL_SIGNAL = /\b(residential|dwellings?|apartments?|condo(minium)?s?|housing|homeownership|townho(use|me)s?|rowhouses?|(one|two|three|four|five|six|single|multi|\d)[\s-]*family|(\d+|residential|dwelling|housing|rental|condo|apartment|affordable)\s+units?)\b/i;
const NONRES: Record<string, RegExp> = {
  hotel: /\b(hotel|keys|guest rooms|lodging|inn)\b/i,
  lab_office: /\b(laborator(y|ies)|lab space|life science|r&d|research and development|office building|office space)\b/i,
  institutional: /\b(dormitor(y|ies)|student housing|hospital|clinic|inpatient|patient|school|university|college|institutional master plan|church|museum)\b/i,
  industrial: /\b(warehouse|industrial|manufacturing|data center|garage for|parking garage|self[- ]storage)\b/i,
};
const ORDINARY = /\b(roof(ing)?|re-?shingl|siding|windows? replace|replace (\w+ )?windows|kitchen (remodel|renovation)|bath(room)? (remodel|renovation)|cosmetic|paint(ing)?|flooring|insulation|solar|sign(age)?|fence|deck|porch|repair|in[- ]kind|like for like|sprinkler|fire alarm|low voltage|electrical only|plumbing only|chimney|masonry repoint)/i;

export const nonresidentialSignals = (t: string | null | undefined): string[] =>
  t ? Object.keys(NONRES).filter((k) => NONRES[k].test(t)) : [];
export const hasResidentialSignal = (t: string | null | undefined): boolean => Boolean(t && RESIDENTIAL_SIGNAL.test(t));
export const isUnitCombination = (t: string | null | undefined): boolean => Boolean(t && UNIT_COMBINATION_RE.test(t));
export const isOrdinaryWork = (t: string | null | undefined): boolean => Boolean(t && (ORDINARY.test(t) || UNIT_COMBINATION_RE.test(t)));

// ---------------------------------------------------------------- named parties
const ORG = "(?:LLC|L\\.L\\.C\\.|Inc\\.?|LP|L\\.P\\.|LLP|Corporation|Corp\\.?|Trust|Partners(?:hip)?|Company|Co\\.|Development(?:s)?|Properties|Realty|Group|Associates|Ventures|Holdings|Capital|Communities|Housing|Collaborative|CDC)";
const ROLE_PAREN = new RegExp(`(?<name>[A-Z0-9][A-Za-z0-9&.,'’\\- ]{1,90}?${ORG})\\s*,?\\s*\\((?:the\\s+)?["“”']?(?<role>Proponent|Developer|Applicant|Owner)["“”']?\\)`, "g");
const ROLE_AFTER = new RegExp(`\\b(?<role>Proponent|Developer|Applicant|Owner)\\s*,\\s*(?<name>[A-Z0-9][A-Za-z0-9&.,'’\\- ]{1,90}?${ORG})`, "g");

export interface NamedParty { role: string; name: string; evidence: string }
export function extractNamedParties(text: string | null | undefined): NamedParty[] {
  if (!text) return [];
  const out: NamedParty[] = [];
  const seen = new Set<string>();
  for (const rx of [ROLE_PAREN, ROLE_AFTER]) {
    for (const m of text.matchAll(rx)) {
      let name = m.groups!.name.trim().replace(/^[ ,]+|[ ,]+$/g, "").replace(/^(The|the)\s+/, "");
      if (name.length > 60) name = name.replace(/^.*\b(by|from|of)\s+/, "");
      const role = m.groups!.role.toLowerCase();
      const key = `${role}|${name.toLowerCase()}`;
      if (seen.has(key) || name.length < 3) continue;
      seen.add(key);
      out.push({ role, name, evidence: m[0].slice(0, 200) });
    }
  }
  return out;
}
