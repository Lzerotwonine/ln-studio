"""Chinese NLP plugin using jieba + bracket regex extraction."""

from __future__ import annotations

import logging
import re
from collections import Counter

import jieba
import jieba.posseg as pseg

from app.services.languages.base import (
    BaseLanguagePlugin,
    ExtractedTerm,
    normalize_term_key,
)

# Suppress noisy jieba loading logs
jieba.setLogLevel(logging.WARNING)

_ZH_BRACKET_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"《([^《》\n]{1,40})》"),
    re.compile(r"【([^【】\n]{1,40})】"),
    re.compile(r"“([^“”\n]{1,24})”"),
    re.compile(r"「([^「」\n]{1,30})」"),
    re.compile(r"『([^『』\n]{1,30})』"),
]

_HAS_CJK_RE = re.compile(r"[\u4E00-\u9FFF]")
_ONLY_PUNCT_DIGITS_RE = re.compile(r"^[\d０-９\W_]+$")

_ZH_NOUN_FLAGS: frozenset[str] = frozenset(
    {"n", "nr", "nrfg", "nrt", "ns", "nt", "nz", "nw", "vn"}
)

_ZH_STOPWORDS: frozenset[str] = frozenset(
    {
        "时候",
        "东西",
        "地方",
        "事情",
        "问题",
        "时间",
        "样子",
        "声音",
        "眼神",
        "目光",
        "眉头",
        "嘴角",
        "身体",
        "心里",
        "心中",
        "世界",
        "力量",
        "众人",
        "自己",
        "大家",
        "对方",
        "别人",
        "今天",
        "明天",
        "昨天",
        "现在",
        "刚才",
        "之前",
        "之后",
        "里面",
        "外面",
        "旁边",
        "面前",
        "身后",
        "不过",
        "但是",
        "因为",
        "所以",
        "如果",
        "虽然",
        "已经",
        "还是",
        "没有",
        "不是",
        "可以",
        "什么",
        "怎么",
        "为什么",
    }
)


class ChinesePlugin(BaseLanguagePlugin):
    """Chinese glossary term extractor using jieba POS tagging and bracket patterns."""

    lang_code = "zh"

    def extract_terms(
        self, texts: list[str], *, min_freq: int = 1
    ) -> list[ExtractedTerm]:
        full_text = "\n".join(t for t in texts if t)
        if not full_text.strip():
            return []

        bracket_counts: Counter[str] = Counter()
        bracket_originals: dict[str, str] = {}
        in_brackets_keys: set[str] = set()

        # Pass 1: Bracketed terms (《》, 【】, “”, 「」, 『』)
        for pattern in _ZH_BRACKET_PATTERNS:
            for match in pattern.finditer(full_text):
                term = match.group(1).strip()
                if not term or len(term) < 2 or len(term) > 24:
                    continue
                # Skip quoted dialogue sentences inside “...”
                if any(p in term for p in ("。", "，", "！", "？", "；", "：", "…")):
                    continue
                if not _HAS_CJK_RE.search(term) or _ONLY_PUNCT_DIGITS_RE.match(term):
                    continue
                norm = normalize_term_key(term)
                if not norm or norm in _ZH_STOPWORDS:
                    continue
                bracket_counts[norm] += 1
                bracket_originals.setdefault(norm, term)
                in_brackets_keys.add(norm)

        # Pass 2: jieba POS tagging
        jieba_counts: Counter[str] = Counter()
        jieba_originals: dict[str, str] = {}
        suggested_types: dict[str, str] = {}

        for word, flag in pseg.cut(full_text):
            cleaned = word.strip()
            if len(cleaned) < 2 or len(cleaned) > 20:
                continue
            if flag not in _ZH_NOUN_FLAGS:
                continue
            if not _HAS_CJK_RE.search(cleaned) or _ONLY_PUNCT_DIGITS_RE.match(cleaned):
                continue
            norm = normalize_term_key(cleaned)
            if not norm or norm in _ZH_STOPWORDS:
                continue
            jieba_counts[norm] += 1
            jieba_originals.setdefault(norm, cleaned)
            if flag in ("nr", "nrfg", "nrt"):
                suggested_types.setdefault(norm, "Character")
            elif flag == "ns":
                suggested_types.setdefault(norm, "Place")
            elif flag == "nt":
                suggested_types.setdefault(norm, "Organization")

        all_keys = set(bracket_counts) | set(jieba_counts)
        results: list[ExtractedTerm] = []
        for norm in all_keys:
            freq = max(bracket_counts.get(norm, 0), jieba_counts.get(norm, 0))
            if freq < min_freq:
                continue
            original = bracket_originals.get(norm) or jieba_originals.get(norm) or norm
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
