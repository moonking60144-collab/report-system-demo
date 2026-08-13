from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from hmac import compare_digest
import json
from pathlib import Path
import tempfile
from typing import Callable

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from .config import Settings
from .transcription import TranscriptionEngine, create_engine


class SegmentResponse(BaseModel):
    startMs: int
    endMs: int
    text: str
    speakerLabel: str | None
    confidence: float | None


class TranscriptionResponse(BaseModel):
    model: str
    segments: list[SegmentResponse]


class HealthResponse(BaseModel):
    status: str
    model: str
    device: str
    computeType: str
    diarizationEnabled: bool


EngineFactory = Callable[[Settings], TranscriptionEngine]


def _authorize(expected_token: str, authorization: str | None) -> None:
    if not expected_token:
        return
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="STT_TOKEN_REQUIRED")
    if not compare_digest(authorization[len(prefix) :], expected_token):
        raise HTTPException(status_code=403, detail="STT_TOKEN_INVALID")


def _read_phrases(value: str) -> list[str]:
    try:
        raw = json.loads(value)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=422, detail="STT_PHRASES_INVALID") from error
    if not isinstance(raw, list):
        raise HTTPException(status_code=422, detail="STT_PHRASES_INVALID")
    if len(raw) > 500:
        raise HTTPException(status_code=422, detail="STT_PHRASES_TOO_MANY")
    phrases: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            raise HTTPException(status_code=422, detail="STT_PHRASES_INVALID")
        normalized = item.strip()
        if len(normalized) > 200:
            raise HTTPException(status_code=422, detail="STT_PHRASE_TOO_LONG")
        if normalized:
            phrases.append(normalized)
    return phrases


async def _save_upload(upload: UploadFile, max_bytes: int) -> Path:
    target = tempfile.NamedTemporaryFile(prefix="meeting-stt-", suffix=".wav", delete=False)
    path = Path(target.name)
    written = 0
    try:
        with target:
            while chunk := await upload.read(1024 * 1024):
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(status_code=413, detail="STT_AUDIO_TOO_LARGE")
                target.write(chunk)
        if written == 0:
            raise HTTPException(status_code=422, detail="STT_AUDIO_EMPTY")
        return path
    except Exception:
        path.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


def create_app(
    settings: Settings | None = None,
    engine_factory: EngineFactory = create_engine,
) -> FastAPI:
    config = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.engine = await asyncio.to_thread(engine_factory, config)
        app.state.inference_gate = asyncio.Semaphore(config.max_concurrency)
        yield

    app = FastAPI(title="Ragic Meeting STT", version="1", lifespan=lifespan)

    @app.get("/health", response_model=HealthResponse)
    async def health(authorization: str | None = Header(default=None)) -> HealthResponse:
        _authorize(config.api_token, authorization)
        engine: TranscriptionEngine = app.state.engine
        return HealthResponse(
            status="ok",
            model=engine.model_name,
            device=config.device,
            computeType=config.compute_type,
            diarizationEnabled=config.diarization_enabled,
        )

    @app.post("/v1/transcriptions", response_model=TranscriptionResponse)
    async def transcribe(
        audio: UploadFile = File(...),
        language: str = Form(...),
        sourceId: str = Form(...),
        durationMs: int = Form(...),
        model: str = Form(...),
        phrases: str = Form("[]"),
        authorization: str | None = Header(default=None),
    ) -> TranscriptionResponse:
        _authorize(config.api_token, authorization)
        if audio.content_type not in {
            "audio/wav",
            "audio/wave",
            "audio/x-wav",
            "audio/vnd.wave",
            "application/octet-stream",
        }:
            await audio.close()
            raise HTTPException(status_code=422, detail="STT_AUDIO_TYPE_INVALID")
        if sourceId not in {"room-mic", "remote-tab"}:
            await audio.close()
            raise HTTPException(status_code=422, detail="STT_SOURCE_INVALID")
        if durationMs <= 0 or durationMs > 30 * 60 * 1000:
            await audio.close()
            raise HTTPException(status_code=422, detail="STT_DURATION_INVALID")
        engine: TranscriptionEngine = app.state.engine
        if model != engine.model_name:
            await audio.close()
            raise HTTPException(status_code=409, detail="STT_MODEL_MISMATCH")
        try:
            parsed_phrases = _read_phrases(phrases)
        except HTTPException:
            await audio.close()
            raise
        audio_path = await _save_upload(audio, config.max_upload_bytes)
        gate: asyncio.Semaphore = app.state.inference_gate
        acquired = False
        try:
            try:
                await asyncio.wait_for(gate.acquire(), timeout=config.queue_timeout_seconds)
                acquired = True
            except TimeoutError as error:
                raise HTTPException(status_code=429, detail="STT_BUSY") from error
            segments = await asyncio.to_thread(
                engine.transcribe,
                audio_path,
                language,
                parsed_phrases,
                durationMs,
            )
            return TranscriptionResponse(
                model=engine.model_name,
                segments=[
                    SegmentResponse(
                        startMs=segment.start_ms,
                        endMs=segment.end_ms,
                        text=segment.text,
                        speakerLabel=segment.speaker_label,
                        confidence=segment.confidence,
                    )
                    for segment in segments
                ],
            )
        finally:
            if acquired:
                gate.release()
            audio_path.unlink(missing_ok=True)

    return app


app = create_app()
