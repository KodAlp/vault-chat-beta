# -*- coding: utf-8 -*-
"""Tests for ocr_lang.py and the --ocr-lang CLI flag.

    cd ingest && python -m pytest ocr_lang_test.py -q

`supported` is injected so the tests do not depend on the installed rapidocr.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import convert  # noqa: E402
import ocr_lang  # noqa: E402

V6 = frozenset("af ch chinese_cht de en es fr it japan nl pl pt tr".split())


def test_vault_language_names_map_to_engine_codes():
    assert ocr_lang.resolve("Türkçe", V6).lang == "tr"
    assert ocr_lang.resolve("TÜRKÇE", V6).lang == "tr"
    assert ocr_lang.resolve("Turkish", V6).lang == "tr"
    assert ocr_lang.resolve("English", V6).lang == "en"
    assert ocr_lang.resolve("İngilizce", V6).lang == "en"
    assert ocr_lang.resolve("Almanca", V6).lang == "de"
    assert ocr_lang.resolve("tr", V6).lang == "tr"
    assert ocr_lang.resolve("zh", V6).lang == "ch"
    assert ocr_lang.resolve("Japonca", V6).lang == "japan"


def test_first_supported_language_wins_and_list_forms_work():
    plan = ocr_lang.resolve("Türkçe, English", V6)
    assert plan.lang == "tr" and plan.requested == ["tr", "en"] and plan.warnings == []
    assert ocr_lang.resolve(["en", "tr"], V6).lang == "en"
    assert ocr_lang.resolve("tr;en", V6).requested == ["tr", "en"]


def test_nothing_requested_is_the_default_without_warning():
    for spec in (None, "", "  ", []):
        plan = ocr_lang.resolve(spec, V6)
        assert plan.lang is None and plan.warnings == []
        assert not plan.has_diacritics


def test_unsupported_script_warns_in_turkish_and_uses_default():
    plan = ocr_lang.resolve("bn", V6)
    assert plan.lang is None
    assert len(plan.warnings) == 1
    msg = plan.warnings[0]
    assert "Bengalce" in msg and "desteklenmiyor" in msg and "varsayılan OCR" in msg


def test_unsupported_then_supported_falls_back_to_the_supported_one():
    plan = ocr_lang.resolve("Bengalce, Türkçe", V6)
    assert plan.lang == "tr"
    assert "'tr'" in plan.warnings[0]


def test_nothing_is_claimed_supported_without_installed_models():
    plan = ocr_lang.resolve("tr", frozenset())
    assert plan.lang is None and plan.warnings  # warns instead of requesting a missing model


def test_unknown_name_is_reported_and_ignored():
    plan = ocr_lang.resolve("Klingonca, tr", V6)
    assert plan.lang == "tr"
    assert any("tanınmadı" in w and "Klingonca" in w for w in plan.warnings)


def test_has_diacritics():
    assert ocr_lang.resolve("tr", V6).has_diacritics
    assert ocr_lang.resolve("tr,en", V6).has_diacritics
    assert not ocr_lang.resolve("en", V6).has_diacritics


def test_cli_flag_parsing(monkeypatch):
    monkeypatch.delenv("VC_OCR_LANG", raising=False)
    base = ["--in", "a.pdf", "--out-dir", "o"]
    assert convert.parse_args(base).ocr_lang is None
    assert convert.parse_args(base + ["--ocr-lang", "tr,en"]).ocr_lang == "tr,en"


def test_cli_flag_env_default(monkeypatch):
    monkeypatch.setenv("VC_OCR_LANG", "tr")
    assert convert.parse_args(["--in", "a.pdf", "--out-dir", "o"]).ocr_lang == "tr"
    assert convert.parse_args(["--in", "a.pdf", "--out-dir", "o", "--ocr-lang", "de"]).ocr_lang == "de"
