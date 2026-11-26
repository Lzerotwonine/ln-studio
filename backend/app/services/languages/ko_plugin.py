"""Korean NLP plugin using kiwipiepy (NNG, NNP extraction with automatic particle stripping)."""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

from kiwipiepy import Kiwi

from app.services.languages.base import (
    BaseLanguagePlugin,
    ExtractedTerm,
    normalize_term_key,
)

_KO_BRACKET_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"《([^《》\n]{1,40})》"),
    re.compile(r"【([^【】\n]{1,40})】"),
    re.compile(r"〈([^〈〉\n]{1,40})〉"),
    re.compile(r"『([^『』\n]{1,40})』"),
    re.compile(r"「([^「」\n]{1,40})」"),
    re.compile(r"\[([^\[\]\n]{1,40})\]"),
    re.compile(r"<([^<>\n]{1,40})>"),
]

_HAS_HANGUL_OR_ALPHA_RE = re.compile(r"[가-힣A-Za-z]")
_ONLY_PUNCT_DIGITS_RE = re.compile(r"^[\d\W_]+$")

_KO_STOPWORDS: frozenset[str] = frozenset(
    {
        "사람",
        "시간",
        "정도",
        "생각",
        "자신",
        "모습",
        "마음",
        "눈빛",
        "목소리",
        "소리",
        "이야기",
        "순간",
        "상황",
        "문제",
        "이유",
        "방법",
        "결과",
        "가능",
        "필요",
        "존재",
        "느낌",
        "기분",
        "표정",
        "상태",
        "공간",
        "주변",
        "앞쪽",
        "뒤쪽",
        "오늘",
        "내일",
        "어제",
        "지금",
        "그때",
        "이번",
        "다음",
        "마지막",
        "처음",
        "모두",
        "누구",
        "무엇",
        "어디",
        "언제",
    }
)


class KoreanPlugin(BaseLanguagePlugin):
    """Korean glossary term extractor using kiwipiepy NNG/NNP tagging."""

    lang_code = "ko"
    _kiwi: Any = None

    @classmethod
    def _get_kiwi(cls) -> Any:
        if cls._kiwi is None:
            cls._kiwi = Kiwi()
        return cls._kiwi

    def extract_terms(
        self, texts: list[str], *, min_freq: int = 1
    ) -> list[ExtractedTerm]:
        full_text = "\n".join(t for t in texts if t)
        if not full_text.strip():
            return []

        bracket_counts: Counter[str] = Counter()
        bracket_originals: dict[str, str] = {}
        in_brackets_keys: set[str] = set()

        # Pass 1: Bracketed terms (Skills, System boxes, Titles, etc.)
        for pattern in _KO_BRACKET_PATTERNS:
            for match in pattern.finditer(full_text):
                term = match.group(1).strip()
                if not term or len(term) > 35:
                    continue
                if any(p in term for p in (".", "!", "?", "…")) and len(term) > 20:
                    continue
                if not _HAS_HANGUL_OR_ALPHA_RE.search(term) or _ONLY_PUNCT_DIGITS_RE.match(term):
                    continue
                norm = normalize_term_key(term)
                if not norm:
                    continue
                bracket_counts[norm] += 1
                bracket_originals.setdefault(norm, term)
                in_brackets_keys.add(norm)

        # Pass 2: kiwipiepy NNG & NNP extraction (particles stripped automatically by Kiwi)
        kiwi = self._get_kiwi()
        kiwi_counts: Counter[str] = Counter()
        kiwi_originals: dict[str, str] = {}
        suggested_types: dict[str, str] = {}

        # Process line by line to keep memory steady on full volumes
        for line in full_text.splitlines():
            line = line.strip()
            if not line:
                continue
            tokens = kiwi.tokenize(line)
            i = 0
            n = len(tokens)
            while i < n:
                tok = tokens[i]
                if tok.tag in ("NNG", "NNP"):
                    # Merge directly adjacent (no space) NNG/NNP compound nouns
                    form = tok.form
                    end_pos = tok.start + tok.len
                    has_nnp = tok.tag == "NNP"
                    j = i + 1
                    while j < n:
                        nxt = tokens[j]
                        if nxt.tag in ("NNG", "NNP") and nxt.start == end_pos:
                            form += nxt.form
                            end_pos = nxt.start + nxt.len
                            has_nnp = has_nnp or (nxt.tag == "NNP")
                            j += 1
                        else:
                            break

                    cleaned = form.strip()
                    norm = normalize_term_key(cleaned)
                    in_br = norm in in_brackets_keys
                    if (
                        norm
                        and (len(norm) >= 2 or in_br)
                        and not _ONLY_PUNCT_DIGITS_RE.match(norm)
                        and (norm not in _KO_STOPWORDS or in_br)
                    ):
                        kiwi_counts[norm] += 1
                        kiwi_originals.setdefault(norm, cleaned)
                        if has_nnp:
                            suggested_types.setdefault(norm, "Character")
                    i = j
                    continue
                i += 1

        all_keys = set(bracket_counts) | set(kiwi_counts)
        results: list[ExtractedTerm] = []
        for norm in all_keys:
            freq = max(bracket_counts.get(norm, 0), kiwi_counts.get(norm, 0))
            if freq < min_freq:
                continue
            original = bracket_originals.get(norm) or kiwi_originals.get(norm) or norm
            results.append(
                ExtractedTerm(
                    source_term=original,
                    normalized_key=norm,
                    freq=freq,
                    reading="",
                    suggested_type=suggested_types.get(norm, "Concept"),
                    in_brackets=norm in in_brackets_keys,
                )
            )

        results.sort(key=lambda item: (-item.freq, item.normalized_key))
        return results
