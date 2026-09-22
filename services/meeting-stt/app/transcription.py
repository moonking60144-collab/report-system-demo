from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .config import Settings


@dataclass(frozen=True)
class TranscriptSegment:
    start_ms: int
    end_ms: int
    text: str
    speaker_label: str | None
    confidence: float | None


class TranscriptionEngine(Protocol):
    @property
    def model_name(self) -> str: ...

    def transcribe(
        self,
        audio_path: Path,
        language: str,
        phrases: list[str],
        duration_ms: int,
    ) -> list[TranscriptSegment]: ...


class SpeakerDiarizer(Protocol):
    def label(self, audio_path: Path, segments: list[TranscriptSegment]) -> list[TranscriptSegment]:
        ...


def _whisper_language(language: str) -> str:
    normalized = language.strip().lower()
    if normalized in {"zh", "zh-tw", "zh-hant", "zh-hans", "cmn-hant-tw"}:
        return "zh"
    return normalized.split("-", 1)[0] or "zh"


def _build_initial_prompt(phrases: list[str], max_characters: int = 4_000) -> str | None:
    selected: list[str] = []
    current_length = 0
    for phrase in phrases:
        separator_length = 1 if selected else 0
        next_length = current_length + separator_length + len(phrase)
        if next_length > max_characters:
            break
        selected.append(phrase)
        current_length = next_length
    return "，".join(selected) or None


class FasterWhisperEngine:
    def __init__(self, settings: Settings, diarizer: SpeakerDiarizer | None = None):
        from faster_whisper import WhisperModel
        import opencc

        self._model_name = settings.model
        self._model = WhisperModel(
            settings.model,
            device=settings.device,
            compute_type=settings.compute_type,
            download_root=settings.model_cache_dir,
            cpu_threads=settings.cpu_threads,
        )
        self._converter = opencc.OpenCC(settings.opencc_config)
        self._diarizer = diarizer

    @property
    def model_name(self) -> str:
        return self._model_name

    def transcribe(
        self,
        audio_path: Path,
        language: str,
        phrases: list[str],
        duration_ms: int,
    ) -> list[TranscriptSegment]:
        initial_prompt = _build_initial_prompt(phrases)
        raw_segments, _ = self._model.transcribe(
            str(audio_path),
            language=_whisper_language(language),
            task="transcribe",
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
            initial_prompt=initial_prompt,
        )
        segments: list[TranscriptSegment] = []
        for raw in raw_segments:
            text = self._converter.convert(raw.text.strip()).strip()
            if not text:
                continue
            start_ms = max(0, min(duration_ms, round(float(raw.start) * 1000)))
            end_ms = max(start_ms, min(duration_ms, round(float(raw.end) * 1000)))
            segments.append(
                TranscriptSegment(
                    start_ms=start_ms,
                    end_ms=end_ms,
                    text=text,
                    speaker_label=None,
                    confidence=None,
                )
            )
        if self._diarizer is not None and segments:
            return self._diarizer.label(audio_path, segments)
        return segments


class PyannoteSpeakerDiarizer:
    def __init__(self, settings: Settings):
        model_path = Path(settings.diarization_model)
        if not model_path.exists() and not settings.huggingface_token:
            raise RuntimeError("MEETING_STT_DIARIZATION_ENABLED=true 需要 HF_TOKEN")
        from pyannote.audio import Pipeline
        import torch

        self._pipeline = (
            Pipeline.from_pretrained(str(model_path))
            if model_path.exists()
            else Pipeline.from_pretrained(
                settings.diarization_model,
                token=settings.huggingface_token,
            )
        )
        if settings.device == "cuda" or (
            settings.device == "auto" and torch.cuda.is_available()
        ):
            self._pipeline.to(torch.device("cuda"))

    def label(
        self, audio_path: Path, segments: list[TranscriptSegment]
    ) -> list[TranscriptSegment]:
        output = self._pipeline(str(audio_path))
        annotation = output.speaker_diarization
        turns = [
            (round(turn.start * 1000), round(turn.end * 1000), str(speaker))
            for turn, speaker in annotation
        ]
        labeled: list[TranscriptSegment] = []
        for segment in segments:
            best_label = None
            best_overlap = 0
            for start_ms, end_ms, speaker in turns:
                overlap = max(
                    0,
                    min(segment.end_ms, end_ms) - max(segment.start_ms, start_ms),
                )
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_label = speaker
            labeled.append(
                TranscriptSegment(
                    start_ms=segment.start_ms,
                    end_ms=segment.end_ms,
                    text=segment.text,
                    speaker_label=best_label,
                    confidence=segment.confidence,
                )
            )
        return labeled


def create_engine(settings: Settings) -> FasterWhisperEngine:
    diarizer = PyannoteSpeakerDiarizer(settings) if settings.diarization_enabled else None
    return FasterWhisperEngine(settings, diarizer)
