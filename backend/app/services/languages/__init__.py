"""Language plugin registry for JA, ZH, and KO."""

from __future__ import annotations

from app.services.languages.base import (
    VALID_TERM_TYPES,
    BaseLanguagePlugin,
    ExtractedTerm,
    normalize_term_key,
)
from app.services.languages.ja_plugin import JapanesePlugin
from app.services.languages.ko_plugin import KoreanPlugin
from app.services.languages.zh_plugin import ChinesePlugin

_PLUGINS: dict[str, BaseLanguagePlugin] = {}


def get_language_plugin(lang_code: str) -> BaseLanguagePlugin:
    code = (lang_code or "ja").lower().strip()
    if code not in _PLUGINS:
        if code == "ja":
            _PLUGINS[code] = JapanesePlugin()
        elif code == "zh":
            _PLUGINS[code] = ChinesePlugin()
        elif code == "ko":
            _PLUGINS[code] = KoreanPlugin()
        else:
            raise ValueError(f"Ngôn ngữ '{lang_code}' không được hỗ trợ (chỉ hỗ trợ ja, zh, ko).")
    return _PLUGINS[code]


__all__ = [
    "BaseLanguagePlugin",
    "ExtractedTerm",
    "VALID_TERM_TYPES",
    "get_language_plugin",
    "normalize_term_key",
]
