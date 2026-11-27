"""FastAPI entrypoint for LN-Studio backend."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.chapters import router as chapters_router
from app.api.continuity import router as continuity_router
from app.api.glossary import router as glossary_router
from app.api.masks import router as masks_router
from app.api.presets import router as presets_router
from app.api.proofread import router as proofread_router
from app.api.series import router as series_router
from app.api.settings import router as settings_router
from app.api.translate import router as translate_router
from app.core.database import PROJECT_ROOT, db_session, get_db_path, init_db

FRONTEND_DIST_DIR = PROJECT_ROOT / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    init_db()
    yield


def create_app(dist_dir: Path | None = None) -> FastAPI:
    app = FastAPI(
        title="LN-Studio API",
        version="0.1.0",
        description="Backend API cho studio dịch Light Novel đa ngôn ngữ (JA/ZH/KO).",
        lifespan=lifespan,
    )

    # CORS for Vite dev server and local development
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health", tags=["system"])
    def health_check() -> dict[str, str]:
        with db_session() as conn:
            journal_mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]
            fk_enabled = conn.execute("PRAGMA foreign_keys;").fetchone()[0]
        return {
            "status": "ok",
            "db_path": str(get_db_path()),
            "journal_mode": str(journal_mode),
            "foreign_keys": "ON" if fk_enabled else "OFF",
        }

    app.include_router(series_router)
    app.include_router(settings_router)
    app.include_router(presets_router)
    app.include_router(chapters_router)
    app.include_router(glossary_router)
    app.include_router(continuity_router)
    app.include_router(masks_router)
    app.include_router(translate_router)
    app.include_router(proofread_router)

    # Auto-serve built frontend if frontend/dist exists
    resolved_dist = dist_dir if dist_dir is not None else FRONTEND_DIST_DIR
    if resolved_dist.is_dir() and (resolved_dist / "index.html").is_file():
        assets_dir = resolved_dist / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def serve_spa(full_path: str) -> FileResponse:
            if full_path.startswith("api/") or full_path == "api":
                raise HTTPException(status_code=404, detail="API endpoint not found.")
            candidate = (resolved_dist / full_path).resolve()
            try:
                candidate.relative_to(resolved_dist.resolve())
            except ValueError:
                raise HTTPException(status_code=404, detail="Not found.")
            if full_path and candidate.is_file():
                return FileResponse(str(candidate))
            return FileResponse(str(resolved_dist / "index.html"))

    return app


app = create_app()
