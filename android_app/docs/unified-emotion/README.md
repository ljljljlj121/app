# Unified edge/cloud emotion delivery

## Delivery

- Branch: `feat/unified-edge-cloud-emotion`
- APK: `F:\app\android_app\delivery\unified-emotion-no-cloud-time-20261031.apk`
- APK SHA-256: see `delivery-no-cloud-time-20261031.json` in this directory.
- Build variant: release, `arm64-v8a`, debug signing inherited from the repository
- App version: `1.1.2` / version code `11`

## October 31 update

The latest utterance's edge image/text result and cloud audio/video result now
appear in large, distinct cards directly below the camera, before the controls,
diagnostics and raw frame history. Both cards refer to the same utterance ID;
a new recording never borrows an older cloud label. Missing modalities, failures
and visual-only fallback remain explicit. The ASR preview shows up to three lines;
the complete transcript remains selectable in the utterance records below.
Cloud elapsed time and completion timestamps are hidden in both the latest-result
card and utterance records; cloud emotion labels and processing states remain visible.

The APK includes the deployment credential in native Android BuildConfig. No key
field or key content appears in the UI. Existing SecureStore overrides remain
compatible; an absent or blank override uses the embedded credential. Connection,
model and segmentation settings remain editable while paused.

Builds read `MER_CLOUD_API_KEY` first, then the default credential from
`F:\app\云端MER\inference_v2.py`; no Python runtime is needed. Building fails if
neither source provides a credential. Do not include credential values or generated
BuildConfig source in logs or delivery documents. An embedded APK credential is
extractable from the APK; hiding it in the UI does not protect it from extraction.

Build from `F:\app\android_app\android` with Java 21 and the Android SDK configured:

```powershell
gradle :edge-emotion:testDebugUnitTest :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --max-workers=4 --console=plain
```

Use the installed Gradle 8.14.3 if the repository wrapper download is unavailable.
No Git LFS or model changes are required for this update.

The four mobile model weights are intentionally absent from Git history and are
distributed by the GitHub Release asset in `release-models.json`. Run
`python android_app/scripts/fetch_release_models.py` after cloning and before
building the APK. The script verifies the bundle and every extracted file.

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
sequence-bound records. The native build embeds the default API key; an existing
`expo-secure-store` override takes precedence. Key values are not displayed or logged.

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
- JS regression suite: 6/6 passed, including newest-utterance result association,
  recording/failed states, visual fallback and unavailable results.
- Native JVM tests: 17 passed, 1 opt-in cloud live test skipped. Coverage includes
  embedded-key fallback, VAD timing, long-text chunking, tokenizer parity, strict
  cloud parsing/retry, visual/text fallback and frame tests.
- Android compile and release packaging use Gradle 8.14.3 and arm64. The upstream
  AAR is retained; Gradle packaging excludes unsupported 32-bit x86 libraries.
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
