from datetime import date

import pytest

from icecap.normalize import (address_keys, content_hash, fingerprint, normalize_address, normalize_entity_name,
                              parse_date, parse_money)
from icecap.textparse import detect_project_types, extract_named_parties, extract_units, nonresidential_signals


@pytest.mark.parametrize("text,units,method", [
    ("Proposed construction of 5 story, mixed use structure containing 32 residential units, ground level retail", 32, "explicit_unit_count"),
    ("One Hundred Seventy Six (176) Residential Units, Retail Space And Parking", 176, "explicit_unit_count"),
    ("convert an existing one family into a three family (as per plans).", 3, "family_conversion_target"),
    ("Change occupancy from three-family to four-family.", 4, "family_conversion_target"),
    ("Erect new single family with a one car garage.", 1, "new_family_dwelling"),
    ("Erect new 6 story multifamily structure with 60 dwelling units, 4 live-work units", 60, "explicit_unit_count"),
    ("Raze existing structure and erect a 5 Unit Residential Dwelling", 5, "explicit_unit_count"),
    ("Construct a Twenty-two (22) unit mixed use residential building", 22, "explicit_unit_count"),
    ("approximately 35-45 residential units", 45, "explicit_unit_count"),
])
def test_extract_units(text, units, method):
    r = extract_units(text)
    assert r.units == units
    assert r.method == method


@pytest.mark.parametrize("text", [
    "construct a new 4-story boutique hotel containing approximately 35–45 keys",
    "Install 3 rooftop units and 2 condensing units",
    "Replace 2 HVAC units on roof",
    "Renovate kitchen and bath",
    "",
    None,
])
def test_extract_units_never_invents(text):
    assert extract_units(text).units is None


def test_existing_units_from_conversion():
    r = extract_units("Change occupancy from two family to 3-family; renovate interior")
    assert (r.units, r.existing) == (3, 2)


def test_project_types():
    assert detect_project_types("Erect new single family") == ["new_construction"]
    assert set(detect_project_types("Raze existing structure and erect a 5 unit building")) >= {"new_construction", "demolition_rebuild"}
    assert detect_project_types("Change occupancy from three-family to four-family. Build a new kitchen") == ["conversion"]
    assert "demolition_only" in detect_project_types("Raze existing garage")
    assert detect_project_types("Construct a rear deck") == []
    assert "substantial_rehab" in detect_project_types("Gut rehab of existing three family")
    assert "mixed_use" in detect_project_types("mixed-use building with ground floor retail")


def test_nonresidential_signals():
    assert "hotel" in nonresidential_signals("boutique hotel with 40 keys")
    assert "lab_office" in nonresidential_signals("new laboratory and office building")
    assert nonresidential_signals("32 residential units") == []


def test_named_parties_only_explicit_roles():
    ps = extract_named_parties('US Wharf LLC (the Proponent) proposes to demolish. Acme Development LLC ("Developer") will build.')
    assert [(p.role, p.name) for p in ps] == [("proponent", "US Wharf LLC"), ("developer", "Acme Development LLC")]
    assert extract_named_parties("The proponent proposes 20 units.") == []


def test_address_normalization_and_keys():
    assert normalize_address("196 Havre ST East Boston 02128") == "196 HAVRE ST"
    assert normalize_address("105 Beach Street") == "105 BEACH ST"
    assert normalize_address("12 Main Street, Unit 3") == "12 MAIN ST"
    assert "90|COMMERCIAL" in address_keys("88-91 Commercial Wharf")
    assert address_keys("90 Commercial Wharf East Row") == ["90|COMMERCIAL"]
    assert address_keys("No number street") == []
    assert len(address_keys("1-999 Long Road")) == 1  # absurd ranges are not expanded


def test_parsers():
    assert parse_money("$8,274,322.00") == 8274322.0
    assert parse_money("") is None
    assert parse_date("10/1/2026") == date(2026, 10, 1)
    assert parse_date("2026-11-05T13:56:36") == date(2026, 11, 5)
    assert parse_date(1454457600000) == date(2016, 2, 3)


def test_hash_and_fingerprint_stable():
    assert content_hash({"b": 1, "a": 2}) == content_hash({"a": 2, "b": 1})
    assert fingerprint([1, None, "x"]) == fingerprint([1, None, "x"])
    assert fingerprint([1]) != fingerprint([2])


def test_entity_name_normalization():
    assert normalize_entity_name("Acme Development, LLC") == normalize_entity_name("ACME DEVELOPMENT L.L.C.")
