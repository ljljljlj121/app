"""Optional desktop verification only; the Android app never calls this script."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

import numpy as np
import onnx
import onnxruntime as ort
import sherpa_onnx
import soundfile as sf
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "modules/edge-emotion/android/src/main/assets"
REV = "63ddc3cd0f2810b68289a7b3876e62ef5d53d6df"
ASR_URL = f"https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/{REV}"
TEMPERATURE = 2.0566793434560156


def sha(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, default=Path(r"F:\边端\edge_image_text_emotion"))
    args = parser.parse_args()
    output = ROOT / "docs/unified-emotion"
    output.mkdir(parents=True, exist_ok=True)
    fixtures = ROOT / "modules/edge-emotion/android/src/androidTest/assets/unified"
    fixtures.mkdir(parents=True, exist_ok=True)
    reference = args.reference / "artifacts/sfemo_DT0_T02_len64_s42_fp32"
    manifest = json.loads((reference / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["trained_for_emotion"] is True
    assert sha(ASSETS / "text_emotion/model.onnx") == manifest["onnx_sha256"]
    checkpoint = args.reference / "runs/sfemo_DT0_T02_len64_s42/best.pt"
    assert sha(checkpoint) == manifest["checkpoint_sha256"]
    assert sha(reference / "calibration.json") == manifest["calibration_sha256"]
    tokenizer = Tokenizer.from_file(str(reference / "tokenizer/tokenizer.json"))
    tokenizer.no_truncation()
    tokenizer.no_padding()
    tokenizer.save(str(fixtures / "tokenizer.json"))
    session = ort.InferenceSession(str(ASSETS / "text_emotion/model.onnx"), providers=["CPUExecutionProvider"])
    samples = json.loads((reference / "runtime_samples.json").read_text(encoding="utf-8"))
    cases = []
    maximum_error = 0.0
    for sample in samples:
        ids = tokenizer.encode(sample["text"], add_special_tokens=False).ids
        chunks = [ids[i:i + 62] for i in range(0, len(ids), 62)]
        result = np.zeros(3)
        total = 0
        for chunk in chunks:
            input_ids = np.zeros((1, 64), dtype=np.int64)
            content = [101, *chunk, 102]
            input_ids[0, :len(content)] = content
            mask = np.zeros_like(input_ids)
            mask[0, :len(content)] = 1
            inputs = {"input_ids": input_ids, "attention_mask": mask, "token_type_ids": np.zeros_like(input_ids)}
            logits = session.run(None, {i.name: inputs[i.name] for i in session.get_inputs()})[0][0].astype(float)
            p = np.exp((logits - logits.max()) / TEMPERATURE)
            result += p / p.sum() * len(chunk)
            total += len(chunk)
        result /= total
        error = float(np.max(np.abs(result - sample["probabilities"])))
        # Cached samples all fit one block. This also checks the selected temperature.
        assert len(chunks) == 1 and error < 1e-4, (sample["sample_id"], error)
        maximum_error = max(maximum_error, error)
        cases.append({"text": sample["text"], "ids": ids, "probabilities": result.tolist()})
    extras = ["Hello WORLD café naïve! 中文，标点。", "你好 [MASK] [UNK] 测试", "é İ 𠀀 🙂 \u0000 \t",
              "a " * 200, "我很高兴，今天真的很开心。" * 25, "", " \n ", "Don't do this 123.45"]
    for text in extras:
        cases.append({"text": text, "ids": tokenizer.encode(text, add_special_tokens=False).ids})
    (fixtures / "text-cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2), encoding="utf-8")
    # JVM tokenizer parity runs without any Android hardware.
    test_path = ROOT / "modules/edge-emotion/android/src/test/java/expo/modules/edgeemotion/TokenizerParityTest.kt"
    def kotlin(value):
        return json.dumps(value, ensure_ascii=False).replace("$", "\\$")
    assertions = []
    for row in cases:
        expected = ",".join(f"{x}L" for x in row["ids"])
        assertions.append(f'    assertEquals(listOf<Long>({expected}), tokenizer.encode({kotlin(row["text"])}))')
    code = '''package expo.modules.edgeemotion

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

// Generated from the frozen Hugging Face tokenizer by validate_unified_models.py.
class TokenizerParityTest {
  @Test fun allReferenceTextsAndLongUnicodeCasesMatch() {
    val tokenizer = BertTokens(File("src/main/assets/text_emotion/vocab.txt").readLines())
''' + "\n".join(assertions) + "\n  }\n}\n"
    test_path.write_text(code, encoding="utf-8")
    sample_audio = fixtures / "asr-0.wav"
    if not sample_audio.exists():
        urllib.request.urlretrieve(f"{ASR_URL}/test_wavs/0.wav", sample_audio)
    audio, rate = sf.read(str(sample_audio), dtype="float32")
    recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
        paraformer=str(ASSETS / "offline_asr/model.int8.onnx"),
        tokens=str(ASSETS / "offline_asr/tokens.txt"),
        num_threads=2, sample_rate=16000, feature_dim=80, decoding_method="greedy_search")
    import time
    started = time.perf_counter()
    stream = recognizer.create_stream()
    stream.accept_waveform(rate, audio)
    recognizer.decode_stream(stream)
    transcription = stream.result.text
    asr_ms = (time.perf_counter() - started) * 1000
    assert transcription.strip(), "ASR produced empty output on the official sample"
    (fixtures / "asr-reference.txt").write_text(transcription, encoding="utf-8")
    metadata = {p.key: p.value for p in onnx.load(str(ASSETS / "offline_asr/model.int8.onnx")).metadata_props}
    report = {
        "scope": "Desktop CPU model/file verification; not Android performance or end-to-end acceptance",
        "labels": ["positive", "negative", "neutral"], "text_temperature": TEMPERATURE,
        "checkpoint_sha256": sha(checkpoint), "text_onnx_sha256": sha(ASSETS / "text_emotion/model.onnx"),
        "reference_cases": len(samples), "tokenizer_cases": len(cases),
        "max_probability_abs_error": maximum_error,
        "text_inputs": [{"name": i.name, "shape": i.shape, "type": i.type} for i in session.get_inputs()],
        "asr_revision": REV, "asr_sha256": sha(ASSETS / "offline_asr/model.int8.onnx"),
        "tokens_sha256": sha(ASSETS / "offline_asr/tokens.txt"), "asr_metadata": metadata,
        "official_audio_sample_rate": rate, "asr_text": transcription, "desktop_asr_ms": asr_ms,
        "asr_runtime": sherpa_onnx.__version__,
    }
    (output / "model-verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
