from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import os

from dotenv import load_dotenv


load_dotenv()


def _is_loopback_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _read_int(key: str, fallback: int, minimum: int) -> int:
    raw = os.getenv(key, "").strip()
    if not raw:
        return fallback
    try:
        return max(minimum, int(raw))
    except ValueError:
        return fallback


def _read_bool(key: str, fallback: bool) -> bool:
    raw = os.getenv(key, "").strip().lower()
    if not raw:
        return fallback
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return fallback


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    api_token: str
    model: str
    device: str
    compute_type: str
    model_cache_dir: str | None
    cpu_threads: int
    max_concurrency: int
    queue_timeout_seconds: int
    max_upload_bytes: int
    opencc_config: str
    diarization_enabled: bool
    diarization_model: str
    huggingface_token: str

    def __post_init__(self) -> None:
        if not _is_loopback_host(self.host) and not self.api_token:
            raise RuntimeError("跨主機 Meeting STT service 必須設定 MEETING_STT_API_TOKEN")

    @classmethod
    def from_env(cls) -> "Settings":
        cache_dir = os.getenv("MEETING_STT_MODEL_CACHE_DIR", "").strip()
        return cls(
            host=os.getenv("MEETING_STT_HOST", "127.0.0.1").strip() or "127.0.0.1",
            port=_read_int("MEETING_STT_PORT", 8010, 1),
            api_token=os.getenv("MEETING_STT_API_TOKEN", "").strip(),
            model=os.getenv("MEETING_STT_MODEL", "large-v3").strip() or "large-v3",
            device=os.getenv("MEETING_STT_DEVICE", "auto").strip() or "auto",
            compute_type=os.getenv("MEETING_STT_COMPUTE_TYPE", "default").strip()
            or "default",
            model_cache_dir=cache_dir or None,
            cpu_threads=_read_int("MEETING_STT_CPU_THREADS", 4, 1),
            max_concurrency=_read_int("MEETING_STT_MAX_CONCURRENCY", 1, 1),
            queue_timeout_seconds=_read_int("MEETING_STT_QUEUE_TIMEOUT_SECONDS", 5, 1),
            max_upload_bytes=_read_int(
                "MEETING_STT_MAX_UPLOAD_BYTES", 64 * 1024 * 1024, 1024 * 1024
            ),
            opencc_config=os.getenv("MEETING_STT_OPENCC_CONFIG", "s2twp").strip()
            or "s2twp",
            diarization_enabled=_read_bool("MEETING_STT_DIARIZATION_ENABLED", False),
            diarization_model=os.getenv(
                "MEETING_STT_DIARIZATION_MODEL",
                "pyannote/speaker-diarization-community-1",
            ).strip()
            or "pyannote/speaker-diarization-community-1",
            huggingface_token=os.getenv("HF_TOKEN", "").strip(),
        )
