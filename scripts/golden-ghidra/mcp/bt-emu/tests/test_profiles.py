import copy
import json
from pathlib import Path

import pytest

from bt_emu_mcp import profiles

PROFILE_DIR = Path(__file__).resolve().parent.parent / "profiles"
NAMES = ["generic-earbud", "pixel-buds-pro-2", "soundcore-q30"]


def test_exactly_the_three_profiles_ship():
    assert sorted(p.stem for p in PROFILE_DIR.glob("*.json")) == sorted(NAMES)


@pytest.mark.parametrize("name", NAMES)
def test_profile_loads_and_validates(name):
    data = profiles.load_profile(name)
    assert data["id"] == name
    assert profiles.validate(data) == []


def test_generic_earbud_is_fully_specified():
    data = profiles.load_profile("generic-earbud")
    assert not data.get("skeleton")
    assert profiles.find_unknowns(data) == []
    uuids = [s["uuid"] for s in data["gatt"]["services"]]
    assert uuids == ["180F", "180A"]
    assert data["a2dp_sink"]["codecs"][0]["type"] == "SBC"


@pytest.mark.parametrize("name", ["pixel-buds-pro-2", "soundcore-q30"])
def test_skeletons_mark_unknowns_and_carry_provenance(name):
    data = profiles.load_profile(name)
    assert data["skeleton"] is True
    assert len(profiles.find_unknowns(data)) > 5
    assert data["provenance"]["still_needs_capture"]
    assert data["a2dp_sink"] == {"unknown": True, "note": data["a2dp_sink"]["note"]}


def test_soundcore_invents_no_gatt():
    data = profiles.load_profile("soundcore-q30")
    assert data["gatt"]["services"] == []
    assert data["advertising"]["manufacturer_data"] == {"unknown": True}


def test_pixel_buds_only_recorded_head_tracker_values():
    data = profiles.load_profile("pixel-buds-pro-2")
    svc = next(s for s in data["gatt"]["services"] if s["uuid"].startswith("109b862f"))
    version = next(c for c in svc["characteristics"] if c["uuid"].startswith("b4eb9919"))
    assert bytes.fromhex(version["value_hex"]).startswith(b"#AndroidHeadTracker#2.0#2")
    report = next(c for c in svc["characteristics"] if c["uuid"].startswith("e66dd173"))
    assert "value_hex" not in report


def test_invalid_profiles_are_rejected():
    good = profiles.load_profile("generic-earbud")
    bad = copy.deepcopy(good)
    bad["gatt"]["services"][0]["characteristics"][0]["value_hex"] = "zz"
    with pytest.raises(profiles.ProfileError):
        profiles.load_profile(bad)
    bad = copy.deepcopy(good)
    bad["gatt"]["services"][0]["uuid"] = "not-a-uuid"
    with pytest.raises(profiles.ProfileError):
        profiles.load_profile(bad)
    bad = copy.deepcopy(good)
    bad["gatt"]["services"][0]["characteristics"][0]["notify_script"] = {"interval_ms": 10, "pattern_hex": "00"}
    bad["gatt"]["services"][0]["characteristics"][0]["properties"] = ["read"]
    with pytest.raises(profiles.ProfileError, match="notify"):
        profiles.load_profile(bad)
    with pytest.raises(profiles.ProfileError):
        profiles.load_profile("does-not-exist")


def test_load_from_path(tmp_path):
    p = tmp_path / "mine.json"
    p.write_text(json.dumps(profiles.load_profile("generic-earbud")))
    assert profiles.load_profile(str(p))["id"] == "generic-earbud"
