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
    title: str = Field(..., min_length=1, max_length=255)
    volume_summary: str = ""
    rtas_baseline: float = Field(default=3.0, ge=1.0, le=5.0)
    status: VolumeStatus = "imported"

    @field_validator("title")
    @classmethod
    def strip_title(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Tiêu đề tập không được để trống.")
        return cleaned


class VolumeUpdate(BaseModel):
    volume_number: int | None = Field(default=None, ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=255)
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
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Tiêu đề tập không được để trống.")
        return cleaned


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
