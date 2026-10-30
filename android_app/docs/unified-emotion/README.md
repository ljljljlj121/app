# Unified edge/cloud emotion delivery

## Delivery

- Branch: `feat/unified-edge-cloud-emotion`
- APK: `F:\app\android_app\delivery\unified-edge-cloud-emotion-20261030.apk`
- APK SHA-256: `244220D1366170C8323B1411C79A7D4E60D9957648651BC2DB5DF57F2D40BB3C`
- Build variant: release, `arm64-v8a`, debug signing inherited from the repository
- App version: `1.1.0` / version code `9`

## Runtime behavior

`EmotionScreen` remains the only emotion page and the existing CameraX view owns the
preview, face analysis, and video evidence. A single `AudioRecord` supplies VAD and
PCM. The VAD uses a 500 ms pre-roll, a configurable 1000 ms default silence end,
and a hard 15000 ms limit including pre-roll. A duration-limit segment waits for
quiet before another segment can start. User cancel, background, camera interruption,
media failure, and queue rejection stay distinct from normal silence completion.

After finalization, local ASR/text and cloud HTTP are separate bounded queues. Cloud
latency or failure does not stop local capture. Up to 20 records are retained and
at most four segments are admitted; temporary files are removed after both consumers
finish or are cancelled. Late results are ignored after the page/session epoch changes.

The local path keeps the complete transcript. Text is split into 62 content tokens
per 64-token RBT3 input (`[CLS]` and `[SEP]` occupy the other two positions), then
per-chunk calibrated probabilities are combined by content-token-count weighted
mean. Visual evidence uses A2 mean valid-frame probabilities; F3 combines visual
and text with the configurable default text weight 0.75. Empty transcript, no face,
multiple faces and failures remain explicit; unavailable modalities are not replaced
with neutral. No speaker-to-face identity matching is claimed.

The cloud client uses the demo's Chinese prompt and constrained-output fallbacks,
but uses a 60-second deadline, one transient retry, strict seven-label parsing, and
sequence-bound records. The API key is stored with `expo-secure-store`; it is not
written to logs or the checked-in configuration.

## Pinned models

See `model-lock.json` for exact bytes and hashes. The bundled ASR is
`csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09`, revision
`63ddc3cd0f2810b68289a7b3876e62ef5d53d6df`, using `model.int8.onnx` and `tokens.txt`.
The bundled text model is the evaluated emotion head
`sfemo_DT0_T02_len64_s42`, not base RBT3; it includes tokenizer, calibration,
frozen metadata and the ONNX export. `prepare_unified_models.py --verify-only`
checks sizes, hashes and rejects Git LFS pointer files. `validate_unified_models.py`
recreates the desktop tokenizer/ONNX/ASR checks without being an app runtime
dependency.

## Verification

- TypeScript: passed (`tsc --noEmit`).
- Existing JS regression suite: 5/5 passed.
- Native JVM tests: 17 tests passed, including VAD timing, long-text chunking,
  tokenizer parity, strict cloud parsing/retry, visual/text fallback and frame tests.
- Android compile and release packaging: passed with Gradle 8.14.3; the duplicate
  x86 ORT entries in the upstream AAR were removed because the release is arm64.
- Text model desktop check: 30 frozen samples, maximum probability error about
  `9.9e-7`; labels and three model inputs verified.
- ASR desktop check: official model sample produced non-empty output in about
  `187 ms` on this PC. This is not phone latency.
- Native HTTP client reference check: authorized reference pair returned `angry`
  in about `971 ms`; result is recorded in `cloud-live-verification.json`.
- Android instrumentation APK was assembled, but no instrumentation result is
  claimed: ADB had no usable device and the local emulator remained `offline`.

## Remaining acceptance

Install the APK on a physical arm64 Android phone and validate camera/microphone
permissions, 15-second recording, MP4/WAV playback, ASR quality, memory/thermal
behavior, FPS while ASR/text/cloud tasks run, background/return, lens switching,
slow/failed cloud requests, and real queue behavior. The current environment has no
online physical device; no phone model, phone memory, phone latency or phone FPS is
being fabricated.
