from __future__ import annotations

import pytest

from app.config import Settings


def test_settings_read_runtime_contract(monkeypatch) -> None:
    monkeypatch.setenv("MEETING_STT_HOST", "0.0.0.0")
    monkeypatch.setenv("MEETING_STT_PORT", "9010")
    monkeypatch.setenv("MEETING_STT_API_TOKEN", "secret")
    monkeypatch.setenv("MEETING_STT_MODEL", "large-v3-turbo")
    monkeypatch.setenv("MEETING_STT_DEVICE", "cuda")
    monkeypatch.setenv("MEETING_STT_COMPUTE_TYPE", "float16")
    monkeypatch.setenv("MEETING_STT_MAX_CONCURRENCY", "2")
    monkeypatch.setenv("MEETING_STT_DIARIZATION_ENABLED", "true")

    result = Settings.from_env()

    assert result.host == "0.0.0.0"
    assert result.port == 9010
    assert result.api_token == "secret"
    assert result.model == "large-v3-turbo"
    assert result.device == "cuda"
    assert result.compute_type == "float16"
    assert result.max_concurrency == 2
    assert result.diarization_enabled is True


def test_non_loopback_service_requires_api_token(monkeypatch) -> None:
    monkeypatch.setenv("MEETING_STT_HOST", "0.0.0.0")
    monkeypatch.delenv("MEETING_STT_API_TOKEN", raising=False)

    with pytest.raises(RuntimeError, match="MEETING_STT_API_TOKEN"):
        Settings.from_env()
