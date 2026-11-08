"""Conservative information extraction from official free-text descriptions.

Everything extracted here is labelled as text-derived (lower confidence than structured fields)
and is never used to *invent* values: if no explicit statement is found, the result is None.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

NUM_WORDS = {
    "one": 1, "single": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30,
    "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
_WORD_NUM = r"(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]?(?:one|two|three|four|five|six|seven|eight|nine)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)"
_NUM = rf"(?:\d{{1,4}}|{_WORD_NUM})"

UNIT_NOUN = r"(?:units?|apartments?|condominiums?|condos?|townhouses?|townhomes?|dwellings?|rowhouses?)"
UNIT_QUAL = r"(?:new|residential|dwelling|housing|rental|condominium|condo|apartment|affordable|market[- ]rate|income[- ]restricted|homeownership|ownership|live[- ]work|for[- ]sale)"

# "(167) Residential Units", "32 residential units", "approximately 35-45 units", "Five (5) unit"
UNIT_RE = re.compile(
    rf"(?P<num>{_NUM})(?:\s*\((?P<paren>\d{{1,4}})\))?(?:\s*(?:-|–|to)\s*(?P<hi>\d{{1,4}}))?"
    rf"[\s-]+(?:{UNIT_QUAL}[\s-]+){{0,3}}(?P<noun>{UNIT_NOUN})\b",
    re.I,
)
NON_DWELLING_CONTEXT = re.compile(
    r"(rooftop|roof top|condens|hvac|a/c|\bac\b|heat pump|mini[- ]?split|split|storage|parking|rtu|exhaust|"
    r"air handl|handling|fan coil|pthp|ptac|kitchen|furnace|boiler|signage|sign|solar|elevator|retail|"
    r"commercial|office|keys|beds?)\s*$",
    re.I,
)
FAMILY_TARGET_RE = re.compile(rf"\b(?:to|into)\s+(?:an?\s+)?(?P<num>{_NUM}|single)[\s-]*(?:family|fam)\b", re.I)
FAMILY_FROM_RE = re.compile(rf"\bfrom\s+(?:an?\s+)?(?P<num>{_NUM}|single)[\s-]*(?:family|fam)\b", re.I)
FAMILY_RE = re.compile(rf"\b(?P<num>{_NUM}|single)[\s-]*(?:family|fam)\b", re.I)
FROM_TO_UNITS_RE = re.compile(
    rf"\b(?:from\s+)?(?P<a>{_NUM})\s+(?:residential\s+|dwelling\s+)?units?\s+(?:in)?to\s+(?P<b>{_NUM})\s+(?:residential\s+|dwelling\s+)?units?\b", re.I)
UNIT_COMBINATION_RE = re.compile(r"\b(combin(e|ing|ation of) (two |2 )?(residential |dwelling )?units|merg(e|ing) (two |2 )?units)\b", re.I)


def word_to_int(tok: str) -> int | None:
    tok = tok.lower().strip()
    if tok.isdigit():
        return int(tok)
    if tok in NUM_WORDS:
        return NUM_WORDS[tok]
    parts = re.split(r"[\s-]+", tok)
    if len(parts) == 2 and parts[0] in NUM_WORDS and parts[1] in NUM_WORDS:
        return NUM_WORDS[parts[0]] + NUM_WORDS[parts[1]]
    return None


@dataclass
class UnitsResult:
    units: int | None
    existing: int | None = None
    is_range: bool = False
    evidence: str | None = None
    method: str | None = None


def extract_units(text: str | None) -> UnitsResult:
    """Return the proposed residential unit count explicitly stated in text (or None)."""
    if not text:
        return UnitsResult(None)
    t = text.replace("\n", " ")
    ft = FROM_TO_UNITS_RE.search(t)
    if ft:
        a, b = word_to_int(ft.group("a")), word_to_int(ft.group("b"))
        if a is not None and b is not None:
            return UnitsResult(b, a, False, ft.group(0), "explicit_unit_change")
    candidates: list[tuple[int, int, bool, str]] = []   # (priority, units, is_range, evidence)
    for m in UNIT_RE.finditer(t):
        before = t[max(0, m.start() - 30):m.start()]
        if NON_DWELLING_CONTEXT.search(before):
            continue
        noun = m.group("noun").lower()
        n = int(m.group("paren")) if m.group("paren") else word_to_int(m.group("num"))
        if n is None:
            continue
        is_range = bool(m.group("hi"))
        if is_range:
            n = max(n, int(m.group("hi")))
        span = m.group(0)
        qualified = bool(re.search(r"residential|dwelling|housing|rental|condo|apartment|homeownership", span, re.I)) \
            or noun.startswith(("apartment", "condo", "townho", "dwelling", "rowhouse"))
        # skip things like "1 unit" inside "unit 1"/"2 car" etc. and absurd values
        if n <= 0 or n > 5000:
            continue
        context_after = t[m.end():m.end() + 25].lower()
        if noun.startswith("unit") and re.match(r"\s*(of|for)\s+(parking|storage|retail|commercial)", context_after):
            continue
        priority = 2 if qualified else 1
        candidates.append((priority, n, is_range, span.strip()))
    existing = None
    fm = FAMILY_FROM_RE.search(t)
    if fm:
        existing = word_to_int(fm.group("num")) if fm.group("num").lower() != "single" else 1
    if candidates:
        best_pri = max(c[0] for c in candidates)
        best = max((c for c in candidates if c[0] == best_pri), key=lambda c: c[1])
        return UnitsResult(best[1], existing, best[2], best[3], "explicit_unit_count")
    # "convert ... into a three family", "change occupancy from 2 family to 3 family"
    tm = FAMILY_TARGET_RE.search(t)
    if tm and re.search(r"\bconfirm", t[max(0, tm.start() - 40):tm.start()], re.I):
        tm = None
    if tm:
        tok = tm.group("num")
        n = 1 if tok.lower() == "single" else word_to_int(tok)
        if n:
            return UnitsResult(n, existing, False, tm.group(0), "family_conversion_target")
    # "Erect new single family", "new three-family dwelling"
    fm2 = None
    for m in FAMILY_RE.finditer(t):
        ctx = t[max(0, m.start() - 60):m.end() + 45].lower()
        near = t[max(0, m.start() - 14):m.start()].lower()
        if re.search(r"erect|construct|new|build|proposed", ctx) and not re.search(r"existing|confirm|legal", near):
            fm2 = m
            break
    if fm2:
        tok = fm2.group("num")
        n = 1 if tok.lower() == "single" else word_to_int(tok)
        if n:
            return UnitsResult(n, existing, False, fm2.group(0), "new_family_dwelling")
    return UnitsResult(None, existing)


PT_PATTERNS: dict[str, re.Pattern] = {
    "new_construction": re.compile(
        r"\b(erect(ion)?\b|ground[- ]up|new construction|"
        r"construct\w*\b[^.;]{0,60}\b(building|structure|dwelling|residence|townho\w*|rowhouse\w*|units?|single[- ]family|two[- ]family|three[- ]family|multi[- ]?family)\b|"
        r"build (an? )?new [^.;]{0,30}\b(building|structure|dwelling|home|house|residence|townho\w*)\b|"
        r"new (\d+[\s-]*(story|storey) )?(residential|multi[- ]?family|mixed[- ]use) (building|structure|development|project)|"
        r"new (single|two|three|four)[\s-]family)",
        re.I),
    "demolition_rebuild": re.compile(r"\b(raze|demolish|demolition|tear down)\b", re.I),
    "conversion": re.compile(
        r"\b(convert|conversion|change (of )?occupancy|change (of )?use|adaptive(ly)? re-?use|"
        r"from (an? )?\w+[\s-]family to|from (commercial|office|retail|industrial|church|school))", re.I),
    "substantial_rehab": re.compile(
        r"\b(gut (rehab|renovation)|gut[- ]renovat|substantial(ly)? (rehab|renovat|reconstruct)|full(y)? renovat|complete(ly)? renovat|"
        r"major renovation|rehabilitat(e|ion) of (the )?(existing )?(building|structure)|total renovation|down to the studs)", re.I),
    "addition": re.compile(r"\b(addition|dormer|add (an? )?(new )?(\w+ )?(story|stories|floor|level)|vertical expansion)\b", re.I),
    "mixed_use": re.compile(
        r"\b(mixed[- ]use|ground[- ]floor (retail|commercial|restaurant)|first[- ]floor (retail|commercial|restaurant)|"
        r"retail (space|use)|commercial (space|unit))\b", re.I),
}

RESIDENTIAL_SIGNAL = re.compile(
    r"\b(residential|dwellings?|apartments?|condo(minium)?s?|housing|homeownership|townho(use|me)s?|rowhouses?|"
    r"(one|two|three|four|five|six|single|multi|\d)[\s-]*family|"
    r"(\d+|residential|dwelling|housing|rental|condo|apartment|affordable)\s+units?)\b", re.I)
NONRES_SIGNALS = {
    "hotel": re.compile(r"\b(hotel|keys|guest rooms|lodging|inn)\b", re.I),
    "lab_office": re.compile(r"\b(laborator(y|ies)|lab space|life science|r&d|research and development|office building|office space)\b", re.I),
    "institutional": re.compile(r"\b(dormitor(y|ies)|student housing|hospital|clinic|inpatient|patient|school|university|college|institutional master plan|church|museum)\b", re.I),
    "industrial": re.compile(r"\b(warehouse|industrial|manufacturing|data center|garage for|parking garage|self[- ]storage)\b", re.I),
}
ORDINARY_WORK = re.compile(
    r"\b(roof(ing)?|re-?shingl|siding|windows? replace|replace (\w+ )?windows|kitchen (remodel|renovation)|bath(room)? (remodel|renovation)|"
    r"cosmetic|paint(ing)?|flooring|insulation|solar|sign(age)?|fence|deck|porch|repair|in[- ]kind|like for like|"
    r"sprinkler|fire alarm|low voltage|electrical only|plumbing only|chimney|masonry repoint)", re.I)


def detect_project_types(text: str | None) -> list[str]:
    if not text:
        return []
    found = [k for k, rx in PT_PATTERNS.items() if rx.search(text)]
    if "demolition_rebuild" in found and "new_construction" not in found:
        # demolition alone is not a development; keep only if paired with construction
        found.remove("demolition_rebuild")
        found.append("demolition_only")
    return found


def nonresidential_signals(text: str | None) -> list[str]:
    if not text:
        return []
    return [k for k, rx in NONRES_SIGNALS.items() if rx.search(text)]


def has_residential_signal(text: str | None) -> bool:
    return bool(text and RESIDENTIAL_SIGNAL.search(text))


def is_unit_combination(text: str | None) -> bool:
    return bool(text and UNIT_COMBINATION_RE.search(text))


def is_ordinary_work(text: str | None) -> bool:
    return bool(text and (ORDINARY_WORK.search(text) or UNIT_COMBINATION_RE.search(text)))


_ORG_SUFFIX = r"(?:LLC|L\.L\.C\.|Inc\.?|LP|L\.P\.|LLP|Corporation|Corp\.?|Trust|Partners(?:hip)?|Company|Co\.|Development(?:s)?|Properties|Realty|Group|Associates|Ventures|Holdings|Capital|Communities|Housing|Collaborative|CDC|Corporation)"
ROLE_PAREN_RE = re.compile(
    rf"(?P<name>[A-Z0-9][A-Za-z0-9&.,'’\- ]{{1,90}}?{_ORG_SUFFIX})\s*,?\s*\((?:the\s+)?[\"“”']?(?P<role>Proponent|Developer|Applicant|Owner)[\"“”']?\)",
)
ROLE_ON_BEHALF_RE = re.compile(
    rf"\b(?P<role>Proponent|Developer|Applicant|Owner)\s*,\s*(?P<name>[A-Z0-9][A-Za-z0-9&.,'’\- ]{{1,90}}?{_ORG_SUFFIX})")


@dataclass
class NamedParty:
    role: str
    name: str
    evidence: str = field(default="")


def extract_named_parties(text: str | None) -> list[NamedParty]:
    """Find organisations explicitly labelled as Proponent/Developer/Applicant/Owner in official text."""
    if not text:
        return []
    out: list[NamedParty] = []
    seen = set()
    for rx in (ROLE_PAREN_RE, ROLE_ON_BEHALF_RE):
        for m in rx.finditer(text):
            name = re.sub(r"^(The|the)\s+", "", m.group("name").strip(" ,"))
            name = re.sub(r"^.*\b(by|from|of)\s+", "", name) if len(name) > 60 else name
            role = m.group("role").lower()
            key = (role, name.lower())
            if key in seen or len(name) < 3:
                continue
            seen.add(key)
            out.append(NamedParty(role=role, name=name, evidence=m.group(0)[:200]))
    return out
