# Local runtime emotion recognition

This branch adds `实时情绪识别（边端）` to the existing collection app. It is a separate tab and is disabled while recording, so the existing collection and review flows keep ownership of the camera.

## Run

```powershell
cd F:\app\android_app
npm ci
npx expo prebuild --platform android
cd android
.\gradlew.bat assembleRelease
```

The release APK is `android/app/build/outputs/apk/release/app-release.apk` when the build completes. The entry point is the `实时情绪识别（边端）` tab. It defaults to the front camera and supports camera switching, pause/resume, permission recovery, rotation, a face box, current tag/probabilities, and a raw rolling timeline.

The page accepts only one face. `no_face`, `multiple_faces`, invalid crops, model failures, camera failures, and permission failures remain explicit states with `tag=null`; they are not reported as neutral. The UI shows the most recent three seconds and allows viewing the retained 30-second lightweight history. Pause freezes the window; resume starts a new native session. Switching lens and leaving the page clear the window.

No image or video is written or uploaded by this feature. Only structured frame results cross the JS boundary. The native analyzer uses CameraX `KEEP_ONLY_LATEST`, a single background executor, bounded history (900 records / 30 seconds), and releases `ImageProxy`, bitmaps, ONNX results, and camera bindings.

## Model

The bundled model is `modules/edge-emotion/android/src/main/assets/edge_emotion/model.onnx`:

- `sfemo_D0_B05_L1_128_s2026_fp32`, ResNet18, FP32, 44,702,699 bytes
- SHA-256: `a1b4aae101b8a5ba5b41fa1eab2c36cdb985904c0bc41d7883d00da6b1e4ac93`
- Input: RGB, `1x3x128x128`, NCHW float32
- Preprocessing: Pillow-compatible bilinear resize, `/255`, ImageNet mean/std `[.485,.456,.406]` / `[.229,.224,.225]`
- Output: logits; temperature `0.7205746494909738`, then one softmax
- Label order: `positive`, `negative`, `neutral`
- Detector: MediaPipe BlazeFace short-range, IMAGE/CPU, confidence `0.5`; one face required
- Face crop: square side `int(max(w,h)*1.2)`, centered on detector box, black padding outside the image; no alignment

The original model evidence includes PC ONNX parity at probability error below `1e-3`. Because the detector changes from the training/report Haar detector to MediaPipe, `docs/edge-emotion/pc-reference.json` and the Android instrumentation test keep detector/crop distribution checks separate from same-tensor parity.

## Validation

- `tsc --noEmit`: passed.
- `node --test tests/*.cjs`: 5/5 passed, including raw frame IDs, null no-face tags, duplicate batches, pause/session reset, 3/30-second expiry, and capacity.
- `:edge-emotion:compileDebugKotlin`: passed.
- `:edge-emotion:testDebugUnitTest`: passed.
- PC reference generation: passed; 6 synthetic preprocessing cases, 10 real crop tensor cases, 12 source-group midpoint detector cases.
- Android instrumentation parity test is present at `modules/edge-emotion/android/src/androidTest`; `:edge-emotion:compileDebugAndroidTestKotlin` and `:edge-emotion:assembleDebugAndroidTest` passed, but it has not been run because no usable device/emulator is online.
- `:app:assembleRelease`: passed; APK is `F:\app\android_app\android\app\build\outputs\apk\release\app-release.apk`, SHA-256 `A970E7451766858C97C44A16F81336F4DB505B5D7B37821573B578D5691D88FF`.
- Real-device performance remains unverified: no physical device is connected, and the local emulator is `offline` because the Windows Android Emulator Hypervisor Driver is not installed. No 30–60 minute stability, P95, FPS, temperature, or memory result is claimed.

## Camera startup fix (2026-10-29)

The camera fix APK is `F:\app\android_app\delivery\app-emotion-camera-fix-20261029.apk`. See `docs/edge-emotion/camera-fix-2026-10-29.md` for the diagnosis, changes and phone follow-up. The native layout defect is corrected; successful startup on the reporting phone still needs verification.

## Per-frame inference fix (2026-10-29)

Inference-fix APK: `F:\app\android_app\delivery\app-emotion-inference-fix-20261029.apk`. Detection and emotion classification now share one MPImage lifetime, preventing recycled bitmap reads. Errors show their processing stage and exception in the UI. The eight native JVM tests (including four bitmap ownership tests) pass. The native runtime instrumentation APK was built but not executed; successful phone predictions still require verification. See `docs/edge-emotion/inference-fix-2026-10-29.md`.

## Horizontal raw-frame window (2026-10-30)

Latest APK: `F:\app\android_app\delivery\app-emotion-timeline-20261030.apk`. The raw frame history is now a single horizontal row of colored square cells, one per analyzed frame. Tap a cell for confidence/timestamp/error details; drag to inspect history and tap the follow control to return to the latest frame. The 3/30-second windows and bounded raw records are unchanged. See `docs/edge-emotion/timeline-2026-10-30.md` for checks and the sample preview.
