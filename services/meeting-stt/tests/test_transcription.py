from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import opencc

from app.transcription import (
    FasterWhisperEngine,
    PyannoteSpeakerDiarizer,
    TranscriptSegment,
    _build_initial_prompt,
    _whisper_language,
)


def test_taiwan_language_codes_map_to_whisper_chinese() -> None:
    assert _whisper_language("zh-TW") == "zh"
    assert _whisper_language("cmn-Hant-TW") == "zh"
    assert _whisper_language("en-US") == "en"


def test_opencc_s2twp_converts_to_taiwan_traditional_terms() -> None:
    converter = opencc.OpenCC("s2twp")
    assert converter.convert("计算机软件和鼠标") == "計算機軟體和滑鼠"


def test_initial_prompt_has_a_total_character_limit() -> None:
    assert _build_initial_prompt(["螺帽", "品管"], max_characters=5) == "螺帽，品管"
    assert _build_initial_prompt(["螺帽", "品管"], max_characters=4) == "螺帽"


def test_faster_whisper_output_is_converted_without_fake_confidence() -> None:
    captured: dict[str, object] = {}

    class FakeModel:
        def transcribe(self, _: str, **kwargs: object):
            captured.update(kwargs)
            return (
                [
                    SimpleNamespace(
                        start=0.1,
                        end=0.9,
                        text="计算机软件",
                        avg_logprob=-0.1,
                    )
                ],
                None,
            )

    engine = FasterWhisperEngine.__new__(FasterWhisperEngine)
    engine._model_name = "large-v3"
    engine._model = FakeModel()
    engine._converter = opencc.OpenCC("s2twp")
    engine._diarizer = None

    result = engine.transcribe(Path("audio.wav"), "zh-TW", ["螺帽"], 1_000)

    assert captured["language"] == "zh"
    assert captured["initial_prompt"] == "螺帽"
    assert result == [
        TranscriptSegment(
            start_ms=100,
            end_ms=900,
            text="計算機軟體",
            speaker_label=None,
            confidence=None,
        )
    ]


def test_diarizer_assigns_the_speaker_with_the_largest_overlap() -> None:
    diarizer = PyannoteSpeakerDiarizer.__new__(PyannoteSpeakerDiarizer)
    diarizer._pipeline = lambda _: SimpleNamespace(
        speaker_diarization=[
            (SimpleNamespace(start=0.0, end=0.4), "SPEAKER_00"),
            (SimpleNamespace(start=0.4, end=1.0), "SPEAKER_01"),
        ]
    )

    result = diarizer.label(
        Path("audio.wav"),
        [
            TranscriptSegment(
                start_ms=200,
                end_ms=900,
                text="會議內容",
                speaker_label=None,
                confidence=0.9,
            )
        ],
    )

    assert result[0].speaker_label == "SPEAKER_01"
