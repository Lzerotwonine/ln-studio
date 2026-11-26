"""Japanese NLP plugin using SudachiPy (SplitMode.C) + bracket/katakana/compound extractors."""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

from sudachipy import Dictionary, SplitMode

from app.services.languages.base import (
    BaseLanguagePlugin,
    ExtractedTerm,
    normalize_term_key,
)

# Inline furigana attached to Kanji, e.g. 魔法（まほう） or 魔法(まほう)
_FURIGANA_RE = re.compile(
    r"(?<=[\u4E00-\u9FFF々ヶ〆〇])[（(][\u3040-\u309F\u30A0-\u30FFー・\s]{1,24}[）)]"
)

# Bracket patterns (allowing nested furigana parentheses inside angle/square brackets)
_BRACKET_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"《([^《》\n]{1,60})》"),
    re.compile(r"〈([^〈〉\n]{1,60})〉"),
    re.compile(r"『([^『』\n]{1,60})』"),
    re.compile(r"【([^【】\n]{1,60})】"),
    re.compile(r"≪([^≪≫\n]{1,60})≫"),
    re.compile(r"［([^［］\n]{1,60})］"),
    # Standalone parenthesized terms (excluding furigana immediately following Kanji)
    re.compile(r"(?<![\u4E00-\u9FFF々ヶ〆〇])（([^（）\n]{2,40})）"),
]

# POS-independent continuous Katakana scanner
_KATAKANA_RUN_RE = re.compile(r"[\u30A0-\u30FFー・]{2,}")
_HAS_KATAKANA_LETTER_RE = re.compile(r"[\u30A1-\u30FA]")

# Common Kanji + Hiragana lexical compounds in Light Novels
_KANJI_HIRA_COMPOUND_RE = re.compile(
    r"(?:"
    r"[\u4E00-\u9FFF々]{1,4}(?:使い|け物|入り|習い|持ち主|使い手|裏切り者|生き物|食べ物|飲み物|落とし物|贈り物|成り上がり|引きこもり|通り魔|見習い)"
    r"|(?:化け物|新入り|見習い|魔法使い|魔物使い|獣使い|人形使い|剣使い|槍使い|弓使い|精霊使い|死霊使い|召喚使い|使い手|持ち主|生き物|食べ物|飲み物|落とし物|贈り物|裏切り者|物語|呼び方|戦い方|作り方|使い方)"
    r")"
)

_ONLY_HIRAGANA_RE = re.compile(r"^[\u3040-\u309Fー]+$")
_ONLY_KATAKANA_RE = re.compile(r"^[\u30A0-\u30FFー・]+$")
_ONLY_DIGITS_PUNCT_RE = re.compile(r"^[\d０-９\W_]+$")
_SINGLE_KANJI_RE = re.compile(r"^[\u4E00-\u9FFF々]$")
_HAS_KANJI_OR_KATA_RE = re.compile(r"[\u4E00-\u9FFF々\u30A1-\u30FA]")

# Generic Japanese stopwords that should not clutter a Light Novel glossary
_JA_STOPWORDS: frozenset[str] = frozenset(
    {
        "こと",
        "もの",
        "ため",
        "よう",
        "それ",
        "これ",
        "あれ",
        "どれ",
        "ここ",
        "そこ",
        "あそこ",
        "どこ",
        "わたし",
        "ぼく",
        "おれ",
        "あなた",
        "きみ",
        "かれ",
        "かのじょ",
        "みんな",
        "自分",
        "相手",
        "人間",
        "時間",
        "場所",
        "意味",
        "理由",
        "言葉",
        "気持ち",
        "様子",
        "状態",
        "存在",
        "方法",
        "結果",
        "問題",
        "関係",
        "必要",
        "可能",
        "普通",
        "本当",
        "大丈夫",
        "一緒",
        "最後",
        "最初",
        "今回",
        "今度",
        "今日",
        "明日",
        "昨日",
        "現在",
        "過去",
        "未来",
        "以上",
        "以下",
        "以外",
        "以内",
        "以前",
        "以後",
        "程度",
        "場合",
        "瞬間",
        "途中",
        "周囲",
        "辺り",
        "周り",
        "目の前",
        "一人",
        "二人",
        "三人",
        "全員",
        "全部",
        "全て",
        "何か",
        "誰か",
        "何処",
        "何故",
        # Very generic 1-char Kanji words (excluded unless inside brackets)
        "人",
        "事",
        "物",
        "時",
        "日",
        "年",
        "月",
        "中",
        "前",
        "後",
        "上",
        "下",
        "左",
        "右",
        "内",
        "外",
        "手",
        "目",
        "口",
        "顔",
        "声",
        "気",
        "心",
        "体",
        "方",
        "今",
        "何",
        "私",
        "俺",
        "僕",
        "彼",
        "君",
        "誰",
        "所",
        "場",
        "間",
        "分",
        "秒",
        "回",
        "度",
        "本",
        "枚",
        "匹",
        "頭",
        "名",
        "件",
        "点",
        "個",
        "行",
        "話",
        "感",
        "力",
        "男",
        "女",
        "子",
        "親",
        "家",
        "道",
        "先",
        "次",
        "元",
        "別",
        "他",
        "全",
        "各",
        "数",
        "一",
        "二",
        "三",
        "四",
        "五",
        "六",
        "七",
        "八",
        "九",
        "十",
        "百",
        "千",
        "万",
    }
)

# High-value 1-char Kanji terms often meaningful in fantasy/LN settings when frequent
_SINGLE_KANJI_IMPORTANT_FREQ = 5


def _strip_furigana(text: str) -> str:
    return _FURIGANA_RE.sub("", text)


def _is_valid_term(term: str, *, in_brackets: bool = False) -> bool:
    if not term:
        return False
    if len(term) > 40:
        return False
    if _ONLY_DIGITS_PUNCT_RE.match(term):
        return False
    if not in_brackets and _ONLY_HIRAGANA_RE.match(term):
        return False
    if not _HAS_KANJI_OR_KATA_RE.search(term) and not in_brackets:
        return False
    if term in _JA_STOPWORDS and not in_brackets:
        return False
    return True


def _clean_katakana_run(raw: str) -> str:
    cleaned = raw.strip("・").lstrip("ー")
    if len(cleaned) < 2:
        return ""
    if not _HAS_KATAKANA_LETTER_RE.search(cleaned):
        return ""
    return cleaned


def _iter_safe_chunks(text: str, max_chars: int = 8000) -> list[str]:
    """Chunk text below SudachiPy's ~49KB byte limit while keeping lines intact."""
    chunks: list[str] = []
    buf: list[str] = []
    buf_len = 0
    for line in text.splitlines():
        if buf and buf_len + len(line) + 1 > max_chars:
            chunks.append("\n".join(buf))
            buf = [line]
            buf_len = len(line)
        else:
            buf.append(line)
            buf_len += len(line) + 1
    if buf:
        chunks.append("\n".join(buf))
    return chunks


class JapanesePlugin(BaseLanguagePlugin):
    """Japanese glossary term extractor built on SudachiPy SplitMode.C."""

    lang_code = "ja"
    _tokenizer: Any = None

    @classmethod
    def _get_tokenizer(cls) -> Any:
        if cls._tokenizer is None:
            dictionary = Dictionary()
            cls._tokenizer = (
                dictionary.tokenizer()
                if hasattr(dictionary, "tokenizer")
                else dictionary.create()
            )
        return cls._tokenizer

    def clean_for_nlp(self, text: str) -> str:
        # NEVER delete dialogue inside 「...」 — only replace quotation marks with spaces
        text = text.replace("「", " ").replace("」", " ")
        return _strip_furigana(text)

    def extract_terms(
        self, texts: list[str], *, min_freq: int = 1
    ) -> list[ExtractedTerm]:
        full_raw = "\n".join(t for t in texts if t)
        if not full_raw.strip():
            return []

        bracket_counts: Counter[str] = Counter()
        bracket_originals: dict[str, str] = {}
        in_brackets_keys: set[str] = set()

        # Pass 1: Extract bracketed terms (including terms with furigana inside brackets)
        # Preserve 「...」 dialogue content untouched while scanning all special brackets
        raw_no_quote_del = full_raw.replace("「", " ").replace("」", " ")
        for pattern in _BRACKET_PATTERNS:
            for match in pattern.finditer(raw_no_quote_del):
                inner = match.group(1).strip()
                # Strip inner furigana like 《魔法（まほう）》 -> 魔法
                cleaned = _strip_furigana(inner).strip()
                # Skip long sentences inside brackets (e.g., long quoted utterances)
                if not cleaned or len(cleaned) > 30 or "。" in cleaned or "、" in cleaned:
                    continue
                if _ONLY_HIRAGANA_RE.match(cleaned) and len(cleaned) > 12:
                    continue
                if _ONLY_DIGITS_PUNCT_RE.match(cleaned):
                    continue
                norm = normalize_term_key(cleaned)
                if not norm:
                    continue
                bracket_counts[norm] += 1
                bracket_originals.setdefault(norm, cleaned)
                in_brackets_keys.add(norm)

        # Clean full text for NLP passes (keep dialogue content, strip furigana)
        nlp_text = self.clean_for_nlp(full_raw)

        # Pass 2: POS-independent continuous Katakana scanner
        katakana_counts: Counter[str] = Counter()
        katakana_originals: dict[str, str] = {}
        for match in _KATAKANA_RUN_RE.finditer(nlp_text):
            cleaned = _clean_katakana_run(match.group(0))
            if not cleaned:
                continue
            norm = normalize_term_key(cleaned)
            if not norm or norm in _JA_STOPWORDS:
                continue
            katakana_counts[norm] += 1
            katakana_originals.setdefault(norm, cleaned)

        # Pass 3: Common Kanji + Hiragana lexical compound catcher
        kanji_hira_counts: Counter[str] = Counter()
        kanji_hira_originals: dict[str, str] = {}
        for match in _KANJI_HIRA_COMPOUND_RE.finditer(nlp_text):
            term = match.group(0).strip()
            norm = normalize_term_key(term)
            if not norm or norm in _JA_STOPWORDS:
                continue
            kanji_hira_counts[norm] += 1
            kanji_hira_originals.setdefault(norm, term)

        # Pass 4: SudachiPy SplitMode.C morphological pass (with 接頭辞 + 名詞 merging)
        tokenizer = self._get_tokenizer()
        sudachi_counts: Counter[str] = Counter()
        sudachi_originals: dict[str, str] = {}
        readings: dict[str, str] = {}
        suggested_types: dict[str, str] = {}

        for chunk in _iter_safe_chunks(nlp_text):
            if not chunk.strip():
                continue
            morphemes = list(tokenizer.tokenize(chunk, SplitMode.C))
            i = 0
            n = len(morphemes)
            while i < n:
                m = morphemes[i]
                pos = m.part_of_speech()
                pos0 = pos[0] if len(pos) > 0 else ""
                pos1 = pos[1] if len(pos) > 1 else ""
                pos2 = pos[2] if len(pos) > 2 else ""

                # Merge 接頭辞 (prefix) + 名詞 (noun), e.g., 大英雄, 御神体, 第二次, 第七騎士団
                if pos0 == "接頭辞" and i + 1 < n:
                    nxt = morphemes[i + 1]
                    nxt_pos = nxt.part_of_speech()
                    nxt_pos0 = nxt_pos[0] if len(nxt_pos) > 0 else ""
                    nxt_pos1 = nxt_pos[1] if len(nxt_pos) > 1 else ""
                    is_normal_noun = nxt_pos0 == "名詞" and nxt_pos1 not in ("数詞", "助動詞語幹")
                    is_ordinal_num = (
                        nxt_pos0 == "名詞"
                        and nxt_pos1 == "数詞"
                        and i + 2 < n
                        and morphemes[i + 2].part_of_speech()[0] in ("名詞", "接尾辞")
                    )
                    if is_normal_noun or is_ordinal_num:
                        combined = m.surface() + nxt.surface()
                        combined_reading = (m.reading_form() or "") + (nxt.reading_form() or "")
                        j = i + 2
                        # Absorb trailing nominal suffix (接尾辞-名詞的) or noun after ordinal numeral
                        if j < n:
                            suf = morphemes[j]
                            suf_pos = suf.part_of_speech()
                            if (
                                (len(suf_pos) > 1 and suf_pos[0] == "接尾辞" and suf_pos[1] == "名詞的")
                                or (is_ordinal_num and len(suf_pos) > 0 and suf_pos[0] == "名詞")
                            ):
                                combined += suf.surface()
                                combined_reading += suf.reading_form() or ""
                                j += 1
                        norm = normalize_term_key(combined)
                        if _is_valid_term(norm, in_brackets=(norm in in_brackets_keys)):
                            sudachi_counts[norm] += 1
                            sudachi_originals.setdefault(norm, combined)
                            if combined_reading and norm not in readings:
                                readings[norm] = combined_reading
                        i = j
                        continue

                if pos0 == "名詞" and pos1 in ("固有名詞", "普通名詞"):
                    surface = m.surface()
                    reading = m.reading_form() or ""
                    # Merge trailing nominal suffix (e.g. 魔法 + 使い -> 魔法使い, 冒険 + 者 -> 冒険者)
                    j = i + 1
                    while j < n:
                        nxt = morphemes[j]
                        nxt_pos = nxt.part_of_speech()
                        if (
                            len(nxt_pos) > 1
                            and nxt_pos[0] == "接尾辞"
                            and nxt_pos[1] == "名詞的"
                            and nxt_pos[2] not in ("助数詞", "助数詞可能")
                            and nxt.surface() not in ("的", "さ", "み", "ら", "等", "達", "たち", "ども")
                        ):
                            surface += nxt.surface()
                            reading += nxt.reading_form() or ""
                            j += 1
                        else:
                            break

                    norm = normalize_term_key(surface)
                    # Pure Katakana runs are extracted intact by Pass 2 (avoids Sudachi fragments like ファイア / ボール)
                    if _ONLY_KATAKANA_RE.match(norm):
                        i = j
                        continue
                    in_br = norm in in_brackets_keys
                    if _is_valid_term(norm, in_brackets=in_br):
                        sudachi_counts[norm] += 1
                        sudachi_originals.setdefault(norm, surface)
                        if reading and norm not in readings:
                            readings[norm] = reading
                        if pos1 == "固有名詞":
                            if pos2 == "人名":
                                suggested_types.setdefault(norm, "Character")
                            elif pos2 == "地名":
                                suggested_types.setdefault(norm, "Place")
                            else:
                                suggested_types.setdefault(norm, "Concept")
                    i = j
                    continue

                i += 1

        # Reconcile counts across all passes using max() to avoid double counting
        all_keys = (
            set(bracket_counts)
            | set(katakana_counts)
            | set(kanji_hira_counts)
            | set(sudachi_counts)
        )

        results: list[ExtractedTerm] = []
        for norm in all_keys:
            in_br = norm in in_brackets_keys
            freq = max(
                bracket_counts.get(norm, 0),
                katakana_counts.get(norm, 0),
                kanji_hira_counts.get(norm, 0),
                sudachi_counts.get(norm, 0),
            )
            if freq < min_freq:
                continue

            # Keep 1-char Kanji noun only if in brackets OR high frequency
            if _SINGLE_KANJI_RE.match(norm):
                if not in_br and (norm in _JA_STOPWORDS or freq < _SINGLE_KANJI_IMPORTANT_FREQ):
                    continue

            original = (
                bracket_originals.get(norm)
                or kanji_hira_originals.get(norm)
                or katakana_originals.get(norm)
                or sudachi_originals.get(norm)
                or norm
            )

            results.append(
                ExtractedTerm(
                    source_term=original,
                    normalized_key=norm,
                    freq=freq,
                    reading=readings.get(norm, ""),
                    suggested_type=suggested_types.get(norm, "Concept"),
                    in_brackets=in_br,
                )
            )

        results.sort(key=lambda item: (-item.freq, item.normalized_key))
        return results
