---
trigger: always_on
---
# LN-Studio Project Rules

- Stack: Backend Python 3.12 + FastAPI + SQLite (`docs/schema.sql`), Frontend React + TypeScript + Vite + TailwindCSS.
- AI SDK: Always use `google-genai` (never deprecated `google-generativeai`).
- Database: Single SQLite file at `data/app.db` with WAL mode and foreign keys ON. Never hardcode paths to `/content/drive`.
- Language support: Always abstract NLP logic behind `backend/app/services/languages/base.py` so JA (SudachiPy), ZH (jieba), and KO (kiwipiepy) plug in cleanly.
- Safety & Reliability:
  - Always filter out empty strings in model lists.
  - When a Gemini 429 error contains "PerDay" or "GenerateRequestsPerDay", mark that slot `is_daily_exhausted = 1` for the current date instead of 60s cooldown.
  - Never let an LLM serialize `<GLOSSARY>` to XML; always render XML deterministically from SQLite using `xml.etree.ElementTree` / safe escaping.
- UI Language: Vietnamese labels, clean dark/light workspace UI optimized for long reading/editing sessions.
- Before writing code for a new phase, produce an Implementation Plan artifact first and wait for approval.

- Verification Rule: At the end of every phase, you MUST:
  1. Write and run basic `pytest` smoke tests for all newly added backend endpoints/services.
  2. Run `npm run build` in `frontend/` to guarantee zero TypeScript/Vite build errors.
  3. Only report the phase complete after all tests and build pass.