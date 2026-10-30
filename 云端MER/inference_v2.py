#!/usr/bin/env python3
"""Single-sample multimodal emotion inference with Chinese instructions.

This script is the single-sample counterpart of batch_inference_gt3_zh.py.
It keeps the same Chinese prompt, thinking suppression, structured label-choice
fallbacks, strict label parsing, retries, and latency reporting.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
from pathlib import Path
from time import perf_counter
from typing import Any


LABELS = [
    "happy",
    "sad",
    "angry",
    "fear",
    "disgust",
    "surprise",
    "neutral",
]
LABEL_SET = set(LABELS)

PROMPT_LANGUAGE = "zh-CN"
PROMPT_VERSION = "zh_multimodal_emotion_v1"

SYSTEM_PROMPT = (
    "你是一个确定性的多模态情绪分类器。请直接完成分类，不要思考，"
    "不要输出推理过程、分析、解释、中间步骤或 <think> 标签。"
    "最终回复必须且只能是一个允许的小写英文标签。"
)

USER_PROMPT = (
    "请对所提供的视频和音频进行七分类多模态情绪识别。说话内容为中文，"
    "请准确理解中文语义，并综合语音语调、音量、语速、停顿、面部表情、"
    "眼神和身体动作，判断整个片段中最主要、最明确的情绪。\n"
    "只能从以下标签中选择一个：happy, sad, angry, fear, disgust, surprise, neutral。\n"
    "标签含义：happy 表示开心、愉悦或兴奋；sad 表示悲伤、低落或难过；"
    "angry 表示生气、愤怒或明显不满；fear 表示害怕、紧张、担忧或不安；"
    "disgust 表示厌恶、嫌弃、反感或鄙夷；surprise 表示惊讶、意外或震惊；"
    "neutral 表示没有明确的正面或负面情绪。\n"
    "当不同模态存在冲突时，选择在整个片段中更持续、更明确、可信度更高的情绪。"
    "不要仅仅因为面部表情幅度较小、说话较平静或情绪不夸张就默认选择 neutral；"
    "只有在语义、语气、表情和动作都没有提供明确情绪证据时，才选择 neutral。\n"
    "只输出一个小写英文标签，不要输出标点、解释或任何其他内容。/no_think"
)

# Try the strongest decoding constraint first and fall back for older vLLM
# versions. Every mode retains thinking suppression whenever the server accepts it.
REQUEST_MODES: list[tuple[str, dict[str, Any]]] = [
    (
        "structured_outputs+thinking_disabled",
        {
            "chat_template_kwargs": {"enable_thinking": False},
            "structured_outputs": {"choice": LABELS},
            "stop_token_ids": [151643, 151645],
        },
    ),
    (
        "guided_choice+thinking_disabled",
        {
            "chat_template_kwargs": {"enable_thinking": False},
            "guided_choice": LABELS,
            "stop_token_ids": [151643, 151645],
        },
    ),
    (
        "guided_choice",
        {
            "guided_choice": LABELS,
            "stop_token_ids": [151643, 151645],
        },
    ),
    (
        "thinking_disabled",
        {
            "chat_template_kwargs": {"enable_thinking": False},
            "stop_token_ids": [151643, 151645],
        },
    ),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run Chinese-prompt multimodal emotion inference on one video/audio pair."
    )
    parser.add_argument(
        "--video",
        type=Path,
        default=Path("angry_clip.mp4"),
        help="Input MP4 video path.",
    )
    parser.add_argument(
        "--audio",
        type=Path,
        default=Path("angry_audio1.wav"),
        help="Input WAV audio path.",
    )
    parser.add_argument(
        "--gt",
        type=Path,
        default=None,
        help="Optional gt.txt path. When supplied, correctness is reported.",
    )
    parser.add_argument(
        "--api-base",
        default=os.getenv("OPENAI_BASE_URL", "http://183.62.69.210:9005/v1"),
        help="OpenAI-compatible API base URL.",
    )
    parser.add_argument(
        "--api-key",
        default=os.getenv("OPENAI_API_KEY", "token-abc123"),
        help="API key; OPENAI_API_KEY can also be used.",
    )
    parser.add_argument(
        "--model",
        default="/data2/lzh/emo/checkpoint",
        help="Served model name or path.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=600.0,
        help="Request timeout in seconds.",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=2,
        help="Number of retries after the first failed request.",
    )
    parser.add_argument(
        "--retry-delay",
        type=float,
        default=2.0,
        help="Initial retry delay in seconds; exponential backoff is used.",
    )
    parser.add_argument(
        "--label-only",
        action="store_true",
        help="Print only the predicted label to stdout.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print one JSON object instead of the normal human-readable output.",
    )
    parser.add_argument(
        "--show-raw",
        action="store_true",
        help="Include raw model and reasoning fields in human-readable output.",
    )
    return parser.parse_args()


def encode_base64(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(f"Input file not found: {path}")
    return base64.b64encode(path.read_bytes()).decode("ascii")


def build_messages(video_base64: str, audio_base64: str) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {
                    "type": "video_url",
                    "video_url": {
                        "url": f"data:video/mp4;base64,{video_base64}",
                    },
                },
                {
                    "type": "audio_url",
                    "audio_url": {
                        "url": f"data:audio/wav;base64,{audio_base64}",
                    },
                },
                {"type": "text", "text": USER_PROMPT},
            ],
        },
    ]


def normalize_label(raw_output: str) -> str:
    """Accept only a clean standalone canonical label."""

    value = raw_output.strip().lower()
    value = re.sub(r"^```(?:text)?\s*|\s*```$", "", value).strip()
    value = value.strip(" \t\r\n.,;:!?\"'")
    return value if value in LABEL_SET else ""


def read_gt(path: Path | None) -> str:
    if path is None:
        return ""
    if not path.is_file():
        raise FileNotFoundError(f"GT file not found: {path}")
    value = path.read_text(encoding="utf-8", errors="replace").lstrip("\ufeff").strip().lower()
    if value not in LABEL_SET:
        raise ValueError(
            f"Invalid GT label in {path}: {value!r}. Expected one of: {', '.join(LABELS)}"
        )
    return value


def extract_reasoning_output(message: Any) -> str:
    value = getattr(message, "reasoning_content", None)
    if not value:
        model_extra = getattr(message, "model_extra", None) or {}
        if isinstance(model_extra, dict):
            value = model_extra.get("reasoning_content") or model_extra.get("reasoning")
    return str(value or "").strip()


def has_thinking(raw_output: str, reasoning_output: str) -> bool:
    raw_lower = raw_output.lower()
    return bool(reasoning_output.strip()) or "<think" in raw_lower or "</think>" in raw_lower


def is_bad_request(exc: Exception) -> bool:
    status_code = getattr(exc, "status_code", None)
    if status_code == 400:
        return True
    response = getattr(exc, "response", None)
    return getattr(response, "status_code", None) == 400


def request_completion(client: Any, model: str, messages: list[dict[str, Any]]) -> tuple[Any, str]:
    rejected: list[str] = []

    for mode_name, extra_body in REQUEST_MODES:
        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=8,
                temperature=0,
                top_p=1,
                seed=0,
                extra_body=extra_body,
            )
            return response, mode_name
        except Exception as exc:
            if not is_bad_request(exc):
                raise
            rejected.append(f"{mode_name}: {type(exc).__name__}: {exc}")

    raise RuntimeError(
        "The server rejected every safe request mode. Configure or upgrade the "
        "server to support chat_template_kwargs, structured_outputs, or "
        "guided_choice. Rejections:\n" + "\n".join(rejected)
    )


def run_inference(args: argparse.Namespace) -> dict[str, Any]:
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError("Missing package: pip install -U openai") from exc

    total_start = perf_counter()

    encode_start = perf_counter()
    video_base64 = encode_base64(args.video)
    audio_base64 = encode_base64(args.audio)
    encode_latency = perf_counter() - encode_start

    messages = build_messages(video_base64, audio_base64)
    client = OpenAI(
        api_key=args.api_key,
        base_url=args.api_base,
        timeout=args.timeout,
        max_retries=0,
    )

    raw_output = ""
    reasoning_output = ""
    control_mode = ""
    error = ""
    attempts = 0
    api_latency = 0.0

    for attempt in range(1, args.retries + 2):
        attempts = attempt
        api_start = perf_counter()
        try:
            response, control_mode = request_completion(client, args.model, messages)
            api_latency += perf_counter() - api_start
            message = response.choices[0].message
            raw_output = str(message.content or "").strip()
            reasoning_output = extract_reasoning_output(message)
            error = ""
            break
        except Exception as exc:
            api_latency += perf_counter() - api_start
            error = f"{type(exc).__name__}: {exc}"
            if attempt <= args.retries:
                time.sleep(args.retry_delay * (2 ** (attempt - 1)))

    prediction = normalize_label(raw_output)
    thinking_detected = has_thinking(raw_output, reasoning_output)

    if error:
        status = "api_error"
    elif thinking_detected:
        status = "thinking_detected"
    elif not prediction:
        status = "invalid_output"
    else:
        status = "ok"

    gt_label = read_gt(args.gt)
    correct = prediction == gt_label if gt_label else None

    return {
        "video_path": str(args.video),
        "audio_path": str(args.audio),
        "gt_path": str(args.gt) if args.gt else "",
        "prompt_language": PROMPT_LANGUAGE,
        "prompt_version": PROMPT_VERSION,
        "prediction": prediction,
        "reference_label": gt_label,
        "correct": correct,
        "status": status,
        "thinking_detected": thinking_detected,
        "control_mode": control_mode,
        "raw_output": raw_output,
        "reasoning_output": reasoning_output,
        "attempts": attempts,
        "encode_latency": encode_latency,
        "api_latency": api_latency,
        "total_latency": perf_counter() - total_start,
        "error": error,
    }


def print_result(result: dict[str, Any], args: argparse.Namespace) -> None:
    if args.label_only:
        if result["status"] != "ok":
            print(result["error"] or f"Inference failed: {result['status']}", file=sys.stderr)
            raise SystemExit(2)
        print(result["prediction"])
        return

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    prediction = result["prediction"] or "<invalid>"
    print(prediction)
    print(f"status: {result['status']}")
    print(f"control_mode: {result['control_mode'] or 'none'}")
    print(f"thinking_detected: {str(result['thinking_detected']).lower()}")
    print(f"attempts: {result['attempts']}")
    print(f"encode_latency: {result['encode_latency']:.3f}s")
    print(f"api_latency: {result['api_latency']:.3f}s")
    print(f"total_latency: {result['total_latency']:.3f}s")

    if result["reference_label"]:
        print(f"reference_label: {result['reference_label']}")
        print(f"correct: {str(result['correct']).lower()}")

    if args.show_raw or result["status"] != "ok":
        print(f"raw_output: {result['raw_output']!r}")
        print(f"reasoning_output: {result['reasoning_output']!r}")

    if result["error"]:
        print(f"error: {result['error']}", file=sys.stderr)

    if result["status"] != "ok":
        raise SystemExit(2)


def main() -> None:
    args = parse_args()
    try:
        result = run_inference(args)
        print_result(result, args)
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
