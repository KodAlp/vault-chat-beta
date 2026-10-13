"""OCR language selection for the docling pipeline (#8).

Engine today: RapidOCR (onnxruntime) with the PP-OCRv6 "multi" models that ship
inside the `rapidocr` package (PP-OCRv6_det_small + PP-OCRv6_rec_small). One
recognizer serves ~50 languages — every Latin-script language (Turkish
included), Simplified/Traditional Chinese and Japanese. Scripts outside that
set (Bengali, Arabic, Cyrillic, Devanagari, Korean, Greek, Thai, ...) need
PP-OCRv5 script models that are NOT installed; docling/rapidocr would try to
download them, so we never request them: the caller gets a Turkish warning and
the default recognizer instead of silent garbage (or a surprise download).

Pure functions, no docling import at module level (docling is optional).
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

# PP-OCRv6 recognition codes (rapidocr.utils.model_resolver.PP_OCRV6_LANGS,
# rapidocr 3.9.2). Used when rapidocr cannot be imported to read the real set.
_FALLBACK_V6_CODES = frozenset(
    "af az bs ca ch chinese_cht cs cy da de en es et eu fi fr french ga german gl hr hu id is it "
    "japan ku la lb lt lv mi ms mt nl no oc pl pt qu rm ro rs_latin sk sl sq sv sw tl tr uz vi".split()
)

# ISO 639-1 (or PP-OCR) code the engine uses when it differs from the ISO code.
_ISO_TO_ENGINE = {
    "zh": "ch",
    "zh-tw": "chinese_cht",
    "zh-hant": "chinese_cht",
    "ja": "japan",
    "nb": "no",
    "nn": "no",
    "sr-latn": "rs_latin",
}

def _fold(text: str) -> str:
    """Lowercase + strip diacritics, with Turkish dotless i handled first
    ('Türkçe' -> 'turkce', 'ISPANYOLCA' -> 'ispanyolca')."""
    text = text.replace("İ", "i").replace("I", "ı").lower().replace("ı", "i")
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).strip()


# language name (any language, folded to lowercase ASCII) -> ISO code. Covers
# what a vault's free-text "allowedLanguages" ("Türkçe, English") can contain,
# in Turkish, English and the native name, plus bare codes.
_NAMES: dict[str, str] = {}


def _register(code: str, *names: str) -> None:
    _NAMES[code] = code
    for n in names:
        _NAMES[_fold(n)] = code


_register("tr", "turkce", "turkish", "turkiye", "tur", "turk")
_register("en", "english", "ingilizce", "eng", "inglizce")
_register("de", "deutsch", "german", "almanca", "ger", "deu")
_register("fr", "francais", "french", "fransizca", "fra", "fre")
_register("es", "espanol", "spanish", "ispanyolca", "spa")
_register("it", "italiano", "italian", "italyanca", "ita")
_register("pt", "portugues", "portuguese", "portekizce", "por")
_register("nl", "nederlands", "dutch", "felemenkce", "hollandaca", "nld", "dut")
_register("pl", "polski", "polish", "lehce", "polonyaca", "pol")
_register("cs", "cestina", "czech", "cekce", "ces", "cze")
_register("sk", "slovencina", "slovak", "slovakca", "slk")
_register("sl", "slovenscina", "slovenian", "slovence", "slv")
_register("hr", "hrvatski", "croatian", "hirvatca", "hrv")
_register("bs", "bosanski", "bosnian", "bosnakca", "bos")
_register("hu", "magyar", "hungarian", "macarca", "hun")
_register("ro", "romana", "romanian", "romence", "ron", "rum")
_register("sv", "svenska", "swedish", "isvecce", "swe")
_register("da", "dansk", "danish", "danca", "dan")
_register("no", "norsk", "norwegian", "norvecce", "nor", "nb", "nn", "nob")
_register("fi", "suomi", "finnish", "fince", "fin")
_register("is", "islenska", "icelandic", "izlandaca", "isl")
_register("et", "eesti", "estonian", "estonca", "est")
_register("lv", "latviesu", "latvian", "letonca", "lav")
_register("lt", "lietuviu", "lithuanian", "litvanca", "lit")
_register("ca", "catala", "catalan", "katalanca", "cat")
_register("eu", "euskara", "basque", "baskca", "eus")
_register("gl", "galego", "galician", "glg")
_register("sq", "shqip", "albanian", "arnavutca", "sqi")
_register("id", "indonesia", "bahasa indonesia", "indonesian", "endonezce", "ind")
_register("ms", "melayu", "malay", "malayca", "msa")
_register("vi", "tieng viet", "vietnamese", "vietnamca", "vie")
_register("tl", "tagalog", "filipino", "filipince")
_register("sw", "kiswahili", "swahili", "svahili", "swa")
_register("af", "afrikaans")
_register("az", "azerbaycanca", "azerbaijani", "azeri", "azerice", "aze")
_register("uz", "ozbekce", "uzbek", "ozbek", "uzb")
_register("la", "latina", "latin", "latince", "lat")
_register("ga", "gaeilge", "irish", "irlandaca")
_register("cy", "cymraeg", "welsh", "galce")
_register("mt", "malti", "maltese", "maltaca")
_register("ku", "kurdi", "kurdish", "kurtce", "kmr")
_register("lb", "letzebuergesch", "luxembourgish", "luksemburgca")
_register("zh", "chinese", "cince", "mandarin", "zho", "chi", "zh-cn", "zh-hans", "中文")
_register("zh-tw", "traditional chinese", "geleneksel cince", "zh-hant")
_register("ja", "japanese", "japonca", "jpn", "日本語")
# Scripts the installed models cannot read — recognised so the warning can name them.
_register("ko", "korean", "korece", "kor", "한국어")
_register("ru", "russian", "rusca", "russkij", "rus", "русский")
_register("uk", "ukrainian", "ukraynaca", "ukr")
_register("bg", "bulgarian", "bulgarca", "bul")
_register("sr", "serbian", "sirpca", "srp")
_register("mk", "macedonian", "makedonca", "mkd")
_register("be", "belarusian", "belarusca")
_register("kk", "kazakh", "kazakca", "kaz")
_register("ar", "arabic", "arapca", "ara", "العربية")
_register("fa", "persian", "farsi", "farsca", "fas", "per")
_register("ur", "urdu", "urduca")
_register("he", "hebrew", "ibranice", "heb", "עברית")
_register("hi", "hindi", "hintce", "hin", "हिन्दी")
_register("bn", "bengali", "bangla", "bengalce", "ben", "বাংলা")
_register("ta", "tamil", "tamilce")
_register("te", "telugu", "teluguca")
_register("mr", "marathi", "marati")
_register("ne", "nepali", "nepalce")
_register("th", "thai", "tayca", "tha", "ไทย")
_register("el", "greek", "yunanca", "ellinika", "ell", "gre", "ελληνικά")
_register("ka", "georgian", "gurcuce", "kat")
_register("hy", "armenian", "ermenice", "hye")

# Turkish display names for the warning.
_DISPLAY_TR = {
    "ko": "Korece", "ru": "Rusça", "uk": "Ukraynaca", "bg": "Bulgarca", "sr": "Sırpça (Kiril)",
    "mk": "Makedonca", "be": "Belarusça", "kk": "Kazakça", "ar": "Arapça", "fa": "Farsça",
    "ur": "Urduca", "he": "İbranice", "hi": "Hintçe", "bn": "Bengalce", "ta": "Tamilce",
    "te": "Teluguca", "mr": "Marathi", "ne": "Nepalce", "th": "Tayca", "el": "Yunanca",
    "ka": "Gürcüce", "hy": "Ermenice",
}

_ASCII_LANGS = frozenset({"en", "id", "ms", "la", "sw", "tl"})

SUPPORTED_SUMMARY = "Latin alfabeli diller (Türkçe dahil), Çince ve Japonca"


def _split(spec: str | list[str] | None) -> list[str]:
    if not spec:
        return []
    items = spec if isinstance(spec, list) else [spec]
    out: list[str] = []
    for item in items:
        for part in str(item).replace(";", ",").replace("/", ",").replace("|", ",").split(","):
            part = part.strip()
            if part:
                out.append(part)
    return out


def to_iso(token: str) -> str | None:
    """One user token (name or code, any case) -> ISO code, None when unknown."""
    key = _fold(token)
    if key in _NAMES:
        return _NAMES[key]
    key = key.replace("_", "-")
    return _NAMES.get(key)


def installed_v6_codes() -> frozenset[str]:
    """Recognition codes the INSTALLED rapidocr serves from its bundled PP-OCRv6
    multi model; empty when rapidocr or the bundled recognizer is missing (then
    nothing is claimed as supported and the default engine setting is kept)."""
    try:
        import rapidocr
        from rapidocr.utils.model_resolver import PP_OCRV6_LANGS

        models = Path(rapidocr.__file__).parent / "models"
        if not (models / "PP-OCRv6_rec_small.onnx").is_file():
            return frozenset()
        return frozenset(PP_OCRV6_LANGS)
    except Exception:  # noqa: BLE001 — optional dependency; no claim without proof
        return frozenset()


@dataclass
class OcrPlan:
    """Result of resolving a language request.

    lang: the single PP-OCR code to hand to docling (RapidOCR runs one language
    per run), or None to keep the engine default. warnings: Turkish messages."""

    lang: str | None = None
    requested: list[str] = field(default_factory=list)  # ISO codes, in request order
    warnings: list[str] = field(default_factory=list)

    @property
    def has_diacritics(self) -> bool:
        """True when a requested language is written with characters outside
        ASCII (anything but English/Indonesian/Malay/Latin/Swahili/Tagalog). The
        CodeFormula model mangles those on scanned code (see convert.py
        _set_code_extraction), so convert.py turns CODE recognition off on
        OCR'd pages then. No request / English only keeps it on."""
        return any(i not in _ASCII_LANGS for i in self.requested)


def resolve(spec: str | list[str] | None, supported: frozenset[str] | None = None) -> OcrPlan:
    """Map a request ("tr,en", ["Türkçe", "English"], "bn") onto the engine.

    - nothing requested -> default engine setting, no warning;
    - the first SUPPORTED language wins (RapidOCR is single-language per run, but
      the v6 multi recognizer reads all Latin-script languages together, so
      "tr,en" loses nothing);
    - an unknown name or an unsupported script -> warning, fall back to the next
      supported one, else the default."""
    tokens = _split(spec)
    plan = OcrPlan()
    if not tokens:
        return plan
    if supported is None:
        supported = installed_v6_codes()

    unknown: list[str] = []
    for token in tokens:
        iso = to_iso(token)
        if iso is None:
            unknown.append(token)
        elif iso not in plan.requested:
            plan.requested.append(iso)

    if unknown:
        plan.warnings.append(
            "OCR dili tanınmadı: " + ", ".join(unknown) + " — yok sayıldı."
        )

    unsupported: list[str] = []
    for iso in plan.requested:
        engine = _ISO_TO_ENGINE.get(iso, iso)
        if engine in supported:
            if plan.lang is None:
                plan.lang = engine
        else:
            unsupported.append(iso)

    if unsupported:
        names = ", ".join(_DISPLAY_TR.get(i, i) for i in unsupported)
        tail = (
            f"{plan.lang!r} kodlu OCR kullanıldı"
            if plan.lang
            else "varsayılan OCR kullanıldı"
        )
        plan.warnings.append(
            f"OCR dili desteklenmiyor: {names}. Yüklü OCR modeli yalnızca {SUPPORTED_SUMMARY} okuyabilir; "
            f"{tail}. Bu dildeki taranmış sayfalar bozuk çıkabilir — gözden geçirin."
        )
    return plan
