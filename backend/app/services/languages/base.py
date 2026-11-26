"""Abstract language plugin interface and shared NLP utilities."""

from __future__ import annotations

import unicodedata
from abc import ABC, abstractmethod
from dataclasses import dataclass

VALID_TERM_TYPES: tuple[str, ...] = (
    "Character",
    "Place",
    "Skill",
    "Item",
    "Title",
    "Organization",
    "Race",
    "Creature",
    "Rank",
    "Event",
    "Concept",
    "Language",
    "Currency",
)


def normalize_term_key(term: str) -> str:
    """Normalize a term using NFKC + strip for deduplication in glossary_terms."""
    return unicodedata.normalize("NFKC", term or "").strip()


@dataclass
class ExtractedTerm:
    source_term: str
    normalized_key: str
    freq: int
    reading: str = ""
    suggested_type: str = "Concept"
    in_brackets: bool = False


class BaseLanguagePlugin(ABC):
    """Base contract for JA (SudachiPy), ZH (jieba), and KO (kiwipiepy) NLP plugins."""

    lang_code: str = ""

    @abstractmethod
    def extract_terms(
        self, texts: list[str], *, min_freq: int = 1
    ) -> list[ExtractedTerm]:
        """Extract candidate glossary terms and frequencies from raw chapter texts."""

    def clean_for_nlp(self, text: str) -> str:
        """Optional hook to preprocess raw text before NLP tokenization."""
        return text
