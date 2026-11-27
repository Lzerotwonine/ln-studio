"""Pydantic schemas for LN-Studio Phase 1 REST APIs."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

SourceLang = Literal["ja", "zh", "ko"]
PresetSourceLang = Literal["ja", "zh", "ko", "any"]
TranslationMode = Literal["ln_vn", "freeform", "hybrid"]
VolumeStatus = Literal[
    "imported",
    "glossary_done",
    "continuity_done",
    "translating",
    "completed",
]


class HybridConfig(BaseModel):
    use_glossary: bool = True
    use_characters: bool = True
    use_relationships: bool = True
    use_subarc: bool = False
    rolling_context_lines: int = Field(default=5, ge=0, le=50)


# ---------- Series ----------

class SeriesBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    source_lang: SourceLang = "ja"
    translation_mode: TranslationMode = "ln_vn"
    system_prompt: str = ""
    master_prompt_file: str = "master_prompt_vn.xml"
    hybrid_config: HybridConfig = Field(default_factory=HybridConfig)

    @field_validator("title")
    @classmethod
    def strip_title(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Tên bộ truyện không được để trống.")
        return cleaned


class SeriesCreate(SeriesBase):
    pass


class SeriesUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    source_lang: SourceLang | None = None
    translation_mode: TranslationMode | None = None
    system_prompt: str | None = None
    master_prompt_file: str | None = None
    hybrid_config: HybridConfig | None = None

    @field_validator("title")
    @classmethod
    def strip_optional_title(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Tên bộ truyện không được để trống.")
        return cleaned


class SeriesResponse(SeriesBase):
    id: int
    hybrid_config_json: str
    created_at: str
    volume_count: int = 0


# ---------- Volumes ----------

class VolumeCreate(BaseModel):
    volume_number: int = Field(..., ge=1)
    title: str = Field(default="", max_length=255)
    volume_summary: str = ""
    rtas_baseline: float = Field(default=3.0, ge=1.0, le=5.0)
    status: VolumeStatus = "imported"

    @field_validator("title")
    @classmethod
    def strip_title(cls, v: str) -> str:
        return (v or "").strip()


class VolumeUpdate(BaseModel):
    volume_number: int | None = Field(default=None, ge=1)
    title: str | None = Field(default=None, max_length=255)
    volume_summary: str | None = None
    rtas_baseline: float | None = Field(default=None, ge=1.0, le=5.0)
    rtas_current_avg: float | None = Field(default=None, ge=1.0, le=5.0)
    rtas_drift: str | None = None
    status: VolumeStatus | None = None

    @field_validator("title")
    @classmethod
    def strip_optional_title(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return v.strip()


class VolumeResponse(BaseModel):
    id: int
    series_id: int
    volume_number: int
    title: str
    volume_summary: str
    rtas_baseline: float
    rtas_current_avg: float
    rtas_drift: str
    status: VolumeStatus
    created_at: str


# ---------- API Keys ----------

class ApiKeyCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    api_key: str = Field(..., min_length=1, max_length=512)
    is_active: bool = True

    @field_validator("name", "api_key")
    @classmethod
    def strip_required(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Không được để trống.")
        return cleaned


class ApiKeyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    api_key: str | None = Field(default=None, min_length=1, max_length=512)
    is_active: bool | None = None

    @field_validator("name", "api_key")
    @classmethod
    def strip_optional(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Không được để trống.")
        return cleaned


class ApiKeyResponse(BaseModel):
    id: int
    name: str
    masked_key: str
    is_active: bool


# ---------- Model Config & Quota ----------

class ModelLimitItem(BaseModel):
    rpm: int = Field(default=10, ge=1, le=10000)
    rpd: int = Field(default=250, ge=1, le=1000000)


class ModelConfigPayload(BaseModel):
    models: list[str] = Field(default_factory=list)
    model_limits: dict[str, ModelLimitItem] | None = None


class ModelConfigResponse(BaseModel):
    models: list[str]
    model_limits: dict[str, ModelLimitItem]


class QuotaSlotResponse(BaseModel):
    slot_id: str
    key_name: str
    model_id: str
    requests_today: int
    quota_date: str
    last_request_ts: float
    cooldown_until: float
    cooldown_remaining_sec: float
    is_daily_exhausted: bool
    is_session_disabled: bool
    rpm_used: int
    rpm_limit: int
    rpd_limit: int
    status: Literal["ready", "cooldown", "daily_exhausted", "session_disabled"]
    is_active_slot: bool
    last_error: str | None = None


class QuotaSummary(BaseModel):
    total: int
    active: int
    ready: int
    cooldown: int
    daily_exhausted: int
    session_disabled: int


class QuotaStatusResponse(BaseModel):
    slots: list[QuotaSlotResponse]
    summary: QuotaSummary


class QuotaResetRequest(BaseModel):
    slot_id: str | None = None


class QuotaResetResponse(BaseModel):
    reset_count: int
    slots: list[QuotaSlotResponse]


# ---------- Prompt Presets ----------

class PromptPresetCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)
    source_lang: PresetSourceLang = "ja"
    mode: TranslationMode = "ln_vn"
    content: str = Field(..., min_length=1)

    @field_validator("name", "content")
    @classmethod
    def strip_text(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Không được để trống.")
        return cleaned


class PromptPresetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=150)
    source_lang: PresetSourceLang | None = None
    mode: TranslationMode | None = None
    content: str | None = Field(default=None, min_length=1)

    @field_validator("name", "content")
    @classmethod
    def strip_optional_text(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Không được để trống.")
        return cleaned


class PromptPresetResponse(BaseModel):
    id: int
    name: str
    source_lang: PresetSourceLang
    mode: TranslationMode
    content: str


# ---------- Phase 2: Chapters & Import ----------

SplitMode = Literal["epub_chapters", "chunk_chars"]
GlossaryStatus = Literal["new", "translated", "approved", "ignored"]


class ImportedChapterItem(BaseModel):
    id: int
    volume_id: int
    chapter_index: int
    title: str
    char_count: int
    status: str


class VolumeImportResponse(BaseModel):
    volume_id: int
    filename: str
    split_mode: SplitMode
    keep_furigana: bool
    chapters_imported: int
    total_chars: int
    chapters: list[ImportedChapterItem]


class ChapterSummaryResponse(BaseModel):
    id: int
    volume_id: int
    chapter_index: int
    title: str
    char_count: int
    raw_chars: int = 0
    translated_chars: int = 0
    has_mask: bool = False
    char_ratio: float = 0.0
    preview: str
    status: str
    updated_at: str


class ChapterCreateRequest(BaseModel):
    title: str = Field(default="", max_length=255)
    raw_text: str = Field(..., min_length=1)
    insert_after_index: int | None = Field(default=None, ge=0)


class ChapterUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    raw_text: str | None = None


class ChapterSplitRequest(BaseModel):
    split_offset: int = Field(..., ge=1)
    second_title: str = Field(default="", max_length=255)


class ChapterMergeResponse(BaseModel):
    merged_chapter_id: int
    deleted_chapter_id: int
    chapter_index: int
    title: str
    raw_chars: int
    total_chapters: int


class ChapterSplitResponse(BaseModel):
    first_chapter_id: int
    second_chapter_id: int
    first_chapter_index: int
    second_chapter_index: int
    total_chapters: int


class ChapterDetailResponse(BaseModel):
    id: int
    volume_id: int
    chapter_index: int
    title: str
    raw_text: str
    translated_text: str
    status: str
    updated_at: str


# ---------- Phase 2: Master Glossary ----------

class GlossaryTermCreate(BaseModel):
    source_term: str = Field(..., min_length=1, max_length=120)
    vi_term: str = ""
    reading: str = ""
    han_viet: str = ""
    english_meaning: str = ""
    term_type: str = "Concept"
    status: GlossaryStatus = "new"
    first_seen_vol: int = Field(default=1, ge=1)
    total_freq: int = Field(default=1, ge=1)

    @field_validator("source_term")
    @classmethod
    def strip_source_term(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Thuật ngữ gốc không được để trống.")
        return cleaned


class GlossaryTermUpdate(BaseModel):
    vi_term: str | None = None
    reading: str | None = None
    han_viet: str | None = None
    english_meaning: str | None = None
    term_type: str | None = None
    status: GlossaryStatus | None = None


class GlossaryTermResponse(BaseModel):
    id: int
    series_id: int
    source_term: str
    normalized_key: str
    vi_term: str
    reading: str
    han_viet: str
    english_meaning: str
    term_type: str
    status: GlossaryStatus
    first_seen_vol: int
    total_freq: int
    volume_freq: int | None = None


class GlossaryListResponse(BaseModel):
    items: list[GlossaryTermResponse]
    total_filtered: int
    total_in_scope: int
    status_counts: dict[str, int]


class GlossaryExtractRequest(BaseModel):
    min_freq: int = Field(default=1, ge=1, le=100)


class GlossaryExtractResponse(BaseModel):
    volume_id: int
    series_id: int
    source_lang: str
    total_extracted: int
    new_terms: int
    existing_terms: int


class GlossaryTranslateRequest(BaseModel):
    volume_id: int | None = None
    batch_size: int = Field(default=400, ge=1, le=500)
    max_rounds: int = Field(default=3, ge=1, le=5)


class GlossaryTranslateResponse(BaseModel):
    series_id: int
    volume_id: int | None = None
    total_new_found: int
    translated_count: int
    missing_count: int
    missing_terms: list[str]
    batches_processed: int
    rounds_used: int
    used_slots: list[str]


class GlossaryBulkStatusRequest(BaseModel):
    term_ids: list[int] = Field(default_factory=list)
    status: GlossaryStatus


class GlossaryBulkDeleteRequest(BaseModel):
    term_ids: list[int] = Field(default_factory=list)


class GlossaryImportResponse(BaseModel):
    imported: int
    updated: int
    skipped: int


# ---------- Phase 3: Continuity, Characters & Relationships ----------

CharacterAppearance = Literal["ACTUAL", "MENTIONED"]


class ContinuityStatusResponse(BaseModel):
    volume_id: int
    series_id: int
    volume_number: int
    status: str
    total_chapters: int
    summarized_chapters: int
    characters_count: int
    relationships_total: int
    relationships_needs_review: int
    relationships_locked: int
    relationships_missing_reverse: int
    volume_summary: str
    rtas_baseline: float
    rtas_current_avg: float
    rtas_drift: str


class MapPhaseRequest(BaseModel):
    force_rerun: bool = False
    chapter_ids: list[int] | None = None


class MapChapterSummaryItem(BaseModel):
    chapter_id: int
    chapter_index: int
    title: str
    cached: bool
    events_count: int
    interactions_count: int


class MapPhaseResponse(BaseModel):
    volume_id: int
    total_chapters: int
    processed_chapters: int
    skipped_cached: int
    used_slots: list[str]
    chapters: list[MapChapterSummaryItem]


class ReducePhaseRequest(BaseModel):
    skip_ai_summary: bool = False


class ReducePhaseResponse(BaseModel):
    volume_id: int
    series_id: int
    chapters_reduced: int
    actual_characters: int
    mentioned_characters: int
    relationships_added: int
    relationships_updated: int
    locked_preserved: int
    missing_reverse_created: int
    sub_arc_updated: int
    volume_summary: str
    rtas_current_avg: float
    rtas_drift: str
    used_slot: str | None = None


class CharacterCreate(BaseModel):
    canonical_name: str = Field(..., min_length=1, max_length=150)
    display_name: str = Field(..., min_length=1, max_length=150)
    aliases: list[str] = Field(default_factory=list)
    archetype: str = "NORMAL"
    default_pair: str = "Tôi-Cậu"
    rtas_baseline: float = Field(default=3.5, ge=1.0, le=5.0)
    volume_id: int | None = None
    appearance: CharacterAppearance = "ACTUAL"


class CharacterUpdate(BaseModel):
    canonical_name: str | None = Field(default=None, min_length=1, max_length=150)
    display_name: str | None = Field(default=None, min_length=1, max_length=150)
    aliases: list[str] | None = None
    archetype: str | None = None
    default_pair: str | None = None
    rtas_baseline: float | None = Field(default=None, ge=1.0, le=5.0)


class VolumeCharacterStateUpdate(BaseModel):
    appearance: CharacterAppearance | None = None
    subarc: str | None = None
    current_state: str | None = None
    notes: str | None = None


class CharacterWithStateResponse(BaseModel):
    id: int
    series_id: int
    canonical_name: str
    display_name: str
    aliases: list[str]
    archetype: str
    default_pair: str
    rtas_baseline: float
    appearance: CharacterAppearance
    subarc: str
    current_state: str
    state_notes: str
    in_volume: bool


class RelationshipCreate(BaseModel):
    source_char_id: int
    target_char_id: int
    pair_pronoun: str = ""
    rtas_score: float = Field(default=3.5, ge=1.0, le=5.0)
    notes: str = ""
    evidence_quote: str = ""
    needs_review: bool = True
    is_locked: bool = False
    last_updated_vol: int = Field(default=1, ge=1)


class RelationshipUpdate(BaseModel):
    pair_pronoun: str | None = None
    rtas_score: float | None = Field(default=None, ge=1.0, le=5.0)
    notes: str | None = None
    evidence_quote: str | None = None
    needs_review: bool | None = None
    is_locked: bool | None = None


class RelationshipResponse(BaseModel):
    id: int
    series_id: int
    source_char_id: int
    target_char_id: int
    source_name: str
    source_canonical: str
    target_name: str
    target_canonical: str
    pair_pronoun: str
    rtas_score: float
    notes: str
    evidence_quote: str
    needs_review: bool
    is_locked: bool
    is_missing_reverse: bool
    last_updated_vol: int


class RelationshipApproveRequest(BaseModel):
    pair_pronoun: str | None = None
    notes: str | None = None
    is_locked: bool = False


class RelationshipBulkApproveRequest(BaseModel):
    relationship_ids: list[int] = Field(default_factory=list)
    is_locked: bool = False


class RelevantContextRequest(BaseModel):
    chapter_text: str


class RelevantContextResponse(BaseModel):
    volume_id: int
    matched_characters: list[dict]
    matched_relationships: list[dict]
    matched_glossary: list[dict]
    ignored_shared_parts: list[str]


# ---------- Phase 4: Translation Engine & Sensitive Masks ----------

class TranslateStartRequest(BaseModel):
    start_chapter: int | None = Field(default=None, ge=1)
    end_chapter: int | None = Field(default=None, ge=1)
    chapter_ids: list[int] | None = None
    mode: TranslationMode | None = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    hybrid_config: HybridConfig | None = None
    system_prompt_override: str | None = None
    only_uncompleted: bool = True
    only_failed_or_blocked: bool = False


class RetranslateChapterRequest(BaseModel):
    mode: TranslationMode | None = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    hybrid_config: HybridConfig | None = None
    system_prompt_override: str | None = None


class TranslateChapterRow(BaseModel):
    id: int
    volume_id: int
    chapter_index: int
    title: str
    raw_chars: int
    translated_chars: int
    has_mask: bool
    status: str
    used_slot: str | None = None
    char_ratio: float
    error_message: str | None = None
    updated_at: str


class TranslateStatusResponse(BaseModel):
    volume_id: int
    series_id: int
    job_state: str
    total_targets: int
    done_in_run: int
    current_chapter_index: int | None = None
    counts: dict[str, int]
    chapters: list[TranslateChapterRow]
    recent_logs: list[dict]


class SingleTranslateResultResponse(BaseModel):
    chapter_id: int
    chapter_index: int
    status: str
    used_slot: str | None = None
    char_ratio: float
    retried_with_fiction_context: bool
    error_message: str | None = None


class DebugContextResponse(BaseModel):
    chapter_id: int
    chapter_index: int
    chapter_title: str
    mode: str
    using_masked_text: bool
    source_char_count: int
    system_instruction_length: int
    system_instruction_preview: str
    user_prompt: str
    rolling_context: str
    matched_characters: list[dict]
    matched_relationships: list[dict]
    matched_glossary: list[dict]
    ignored_shared_parts: list[str]


class SensitiveMaskCreate(BaseModel):
    series_id: int | None = None
    raw_phrase: str = Field(..., min_length=1, max_length=255)
    safe_replacement: str = Field(..., min_length=1, max_length=255)


class SensitiveMaskUpdate(BaseModel):
    raw_phrase: str | None = Field(default=None, min_length=1, max_length=255)
    safe_replacement: str | None = Field(default=None, min_length=1, max_length=255)


class SensitiveMaskResponse(BaseModel):
    id: int
    series_id: int | None = None
    raw_phrase: str
    safe_replacement: str
    created_at: str


class SensitiveScanResponse(BaseModel):
    chapter_id: int
    series_id: int
    suggestions: list[dict]
    existing_masks: list[SensitiveMaskResponse]
    used_slot: str


class MaskPairItem(BaseModel):
    raw_phrase: str
    safe_replacement: str


class ApplyMasksRequest(BaseModel):
    extra_masks: list[MaskPairItem] = Field(default_factory=list)
    save_to_db: bool = True
    scope: Literal["series", "global"] = "series"
    clear_mask: bool = False


class ApplyMasksResponse(BaseModel):
    chapter_id: int
    masked_raw_text: str | None = None
    applied_count: int
    applied_masks: list[dict]
    saved_masks_count: int


# ---------- Phase 5: Proofreading & Publication Export ----------

class GlossaryHighlightItem(BaseModel):
    id: int
    source_term: str
    vi_term: str
    reading: str
    han_viet: str
    english_meaning: str
    term_type: str
    status: str


class ChapterProofreadResponse(BaseModel):
    id: int
    volume_id: int
    series_id: int
    chapter_index: int
    title: str
    raw_text: str
    masked_raw_text: str | None = None
    translated_text: str
    status: str
    used_slot: str | None = None
    char_ratio: float
    error_message: str | None = None
    updated_at: str
    glossary_highlights: list[GlossaryHighlightItem]


class SaveTranslationRequest(BaseModel):
    translated_text: str


class SaveTranslationResponse(BaseModel):
    chapter_id: int
    status: str
    char_ratio: float
    translated_chars: int
    updated_at: str


class FindReplaceRequest(BaseModel):
    find_text: str = Field(..., min_length=1)
    replace_text: str = ""
    use_regex: bool = False
    case_sensitive: bool = True
    dry_run: bool = False


class FindReplaceAffectedItem(BaseModel):
    chapter_id: int
    chapter_index: int
    title: str
    matches: int
    sample_snippet: str


class FindReplaceResponse(BaseModel):
    volume_id: int
    dry_run: bool
    use_regex: bool
    case_sensitive: bool
    total_matches: int
    chapters_affected: int
    affected_chapters: list[FindReplaceAffectedItem]


class RetranslateSelectionRequest(BaseModel):
    selected_text: str = Field(..., min_length=1)
    source_side: Literal["raw", "translated"] = "translated"
    instruction: str = ""
    temperature: float = Field(default=0.5, ge=0.0, le=1.5)


class RetranslateSelectionResponse(BaseModel):
    chapter_id: int
    original_selection: str
    retranslated_text: str
    used_slot: str
