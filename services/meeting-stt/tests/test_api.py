from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
from threading import Event

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.transcription import TranscriptSegment


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "host": "127.0.0.1",
        "port": 8010,
        "api_token": "test-token",
        "model": "large-v3",
        "device": "cpu",
        "compute_type": "int8",
        "model_cache_dir": None,
        "cpu_threads": 2,
        "max_concurrency": 1,
        "queue_timeout_seconds": 1,
        "max_upload_bytes": 1024,
        "opencc_config": "s2twp",
        "diarization_enabled": False,
        "diarization_model": "pyannote/speaker-diarization-community-1",
        "huggingface_token": "",
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


class FakeEngine:
    model_name = "large-v3"

    def __init__(self) -> None:
        self.calls: list[tuple[Path, str, list[str], int]] = []

    def transcribe(
        self,
        audio_path: Path,
        language: str,
        phrases: list[str],
        duration_ms: int,
    ) -> list[TranscriptSegment]:
        assert audio_path.read_bytes() == b"RIFF-audio"
        self.calls.append((audio_path, language, phrases, duration_ms))
        return [
            TranscriptSegment(
                start_ms=100,
                end_ms=900,
                text="品質會議開始",
                speaker_label="spk_0",
                confidence=0.93,
            )
        ]


def request_data(**overrides: str) -> dict[str, str]:
    values = {
        "language": "zh-TW",
        "sourceId": "room-mic",
        "durationMs": "1000",
        "model": "large-v3",
        "phrases": '["螺帽", "Funda"]',
    }
    values.update(overrides)
    return values


def auth_headers() -> dict[str, str]:
    return {"Authorization": "Bearer test-token"}


def audio_file(content: bytes = b"RIFF-audio") -> dict[str, tuple[str, bytes, str]]:
    return {"audio": ("chunk.wav", content, "audio/wav")}


def test_health_and_transcription_match_node_contract() -> None:
    engine = FakeEngine()
    app = create_app(settings(), lambda _: engine)

    with TestClient(app) as client:
        health = client.get("/health", headers=auth_headers())
        response = client.post(
            "/v1/transcriptions",
            headers=auth_headers(),
            data=request_data(),
            files=audio_file(),
        )

    assert health.status_code == 200
    assert health.json() == {
        "status": "ok",
        "model": "large-v3",
        "device": "cpu",
        "computeType": "int8",
        "diarizationEnabled": False,
    }
    assert response.status_code == 200
    assert response.json() == {
        "model": "large-v3",
        "segments": [
            {
                "startMs": 100,
                "endMs": 900,
                "text": "品質會議開始",
                "speakerLabel": "spk_0",
                "confidence": 0.93,
            }
        ],
    }
    assert len(engine.calls) == 1
    audio_path, language, phrases, duration_ms = engine.calls[0]
    assert not audio_path.exists()
    assert language == "zh-TW"
    assert phrases == ["螺帽", "Funda"]
    assert duration_ms == 1000


def test_auth_model_and_source_are_fail_closed() -> None:
    app = create_app(settings(), lambda _: FakeEngine())

    with TestClient(app) as client:
        missing_token = client.post(
            "/v1/transcriptions", data=request_data(), files=audio_file()
        )
        wrong_token = client.post(
            "/v1/transcriptions",
            headers={"Authorization": "Bearer wrong"},
            data=request_data(),
            files=audio_file(),
        )
        wrong_model = client.post(
            "/v1/transcriptions",
            headers=auth_headers(),
            data=request_data(model="large-v3-turbo"),
            files=audio_file(),
        )
        wrong_source = client.post(
            "/v1/transcriptions",
            headers=auth_headers(),
            data=request_data(sourceId="browser"),
            files=audio_file(),
        )

    assert missing_token.status_code == 401
    assert missing_token.json()["detail"] == "STT_TOKEN_REQUIRED"
    assert wrong_token.status_code == 403
    assert wrong_token.json()["detail"] == "STT_TOKEN_INVALID"
    assert wrong_model.status_code == 409
    assert wrong_model.json()["detail"] == "STT_MODEL_MISMATCH"
    assert wrong_source.status_code == 422
    assert wrong_source.json()["detail"] == "STT_SOURCE_INVALID"


def test_upload_cap_and_invalid_phrases_leave_no_temp_files(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    app = create_app(settings(max_upload_bytes=4), lambda _: FakeEngine())

    with TestClient(app) as client:
        too_large = client.post(
            "/v1/transcriptions",
            headers=auth_headers(),
            data=request_data(),
            files=audio_file(b"12345"),
        )
        too_many_phrases = client.post(
            "/v1/transcriptions",
            headers=auth_headers(),
            data=request_data(phrases=str(["x"] * 501).replace("'", '"')),
            files=audio_file(),
        )

    assert too_large.status_code == 413
    assert too_large.json()["detail"] == "STT_AUDIO_TOO_LARGE"
    assert too_many_phrases.status_code == 422
    assert too_many_phrases.json()["detail"] == "STT_PHRASES_TOO_MANY"
    assert list(tmp_path.iterdir()) == []


class BlockingEngine(FakeEngine):
    def __init__(self) -> None:
        super().__init__()
        self.started = Event()
        self.release = Event()

    def transcribe(
        self,
        audio_path: Path,
        language: str,
        phrases: list[str],
        duration_ms: int,
    ) -> list[TranscriptSegment]:
        self.started.set()
        assert self.release.wait(timeout=5)
        return super().transcribe(audio_path, language, phrases, duration_ms)


def test_concurrency_gate_returns_busy_instead_of_unbounded_queue() -> None:
    engine = BlockingEngine()
    app = create_app(settings(queue_timeout_seconds=1), lambda _: engine)

    with TestClient(app) as client, ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(
            client.post,
            "/v1/transcriptions",
            headers=auth_headers(),
            data=request_data(),
            files=audio_file(),
        )
        assert engine.started.wait(timeout=2)
        second = client.post(
            "/v1/transcriptions",
            headers=auth_headers(),
            data=request_data(sourceId="remote-tab"),
            files=audio_file(),
        )
        engine.release.set()
        first_response = first.result(timeout=5)

    assert second.status_code == 429
    assert second.json()["detail"] == "STT_BUSY"
    assert first_response.status_code == 200
