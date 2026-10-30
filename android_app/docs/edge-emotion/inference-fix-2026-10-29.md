# Per-frame inference failure (2026-10-29)

## Evidence

The second user screenshot shows a working camera preview and 338 analyzed
frames, with `inference_failed` and `tag=null`. This confirms progress past
camera startup on the reporting phone. Its displayed 27.2 analysis FPS and
153 ms P95 include failed frames and do not prove successful model throughput.

The bundled MediaPipe tasks-core 0.10.21 implementation was inspected directly:

- `BitmapImageBuilder.build()` wraps the original Bitmap without copying.
- `MPImage.close()` closes its image containers at reference count zero.
- `BitmapImageContainer.close()` calls `Bitmap.recycle()`.

The old `EmotionEngine.detect(bitmap)` closed MPImage before returning the
detected boxes. The next step, `classify(bitmap, box)`, read pixels from the
same, already recycled Bitmap. This is a deterministic ownership defect on
the single-face path. There is no phone exception trace yet to exclude an
additional failure on that phone.

## Fix

`withDetectedFaces` now runs detection and the classification callback inside
one `withFrameBitmap` scope. MPImage closes only after all bitmap reads finish,
including exception and no-face paths. It does not copy the image each frame.
The outer analyzer recycles the bitmap only if it has not already been recycled.

Errors retain their original frame ID/timestamps, `tag=null` and explicit failure
status. They now also include an error stage and exception class/message in the
current result and raw frame list. Stack traces go to `EdgeEmotionInference`;
identical repeated errors are logged at most once every five seconds.
The diagnostic collection script includes this log tag.

The ONNX model, labels, temperature, normalization, crop/resize recipe,
detector and runtime dependency versions remain unchanged. Robolectric 4.14.1
is an added test-only dependency; it is not part of the APK runtime.

## Regression coverage

The new Robolectric tests execute the actual MediaPipe Java image wrapper with
Android bitmap shadows. They verify that early MPImage close recycles its input,
that pixels remain readable throughout the processing callback, and that normal,
exception and no-face exits release the image. They do not execute the native
MediaPipe detector or ONNX runtime.

The legacy bitmap shadow does not reproduce every exception thrown by a real
Android Bitmap. The regression therefore checks `isRecycled` and reads pixels
within the live scope; no native bitmap exception is claimed from these tests.

The Android instrumentation detector/parity test has also been updated to use
the same ownership scope and assert lifetime before/after classification. It
requires an online Android device to execute.

## Phone follow-up

Install `F:\app\android_app\delivery\app-emotion-inference-fix-20261029.apk`.
Open the emotion page with one face and confirm raw positive/negative/neutral
tags and probabilities. Then test no face, multiple faces, pause/resume and
front/rear switching. No-face/multiple-face frames must retain `tag=null`.

If another failure occurs, the current-result area now shows its stage and
exception. Connect/authorize USB debugging and collect a log snapshot:

```powershell
cd F:\app\android_app
.\scripts\collect_emotion_camera_logs.ps1 -Adb F:\aliveriver\Android\SDK\platform-tools\adb.exe
```

No physical phone was connected during this fix; the only adb entry was an
offline emulator. Successful on-phone emotion predictions, native inference
parity and performance are not claimed.

## Executed checks and artifacts

- TypeScript: passed.
- Existing JS regression checks: 5/5 passed.
- Native JVM tests: 8/8 passed (four math, four bitmap ownership).
- Instrumentation APK: built successfully; not executed.
- Release APK: built successfully; v2 signature verified.
- Embedded model and detector hashes: verified unchanged.
- New inference guard and log tag: verified in release DEX.
- Robolectric runner: absent from release DEX.
- Diagnostics PowerShell syntax and git diff whitespace: passed.

APK: `F:\app\android_app\delivery\app-emotion-inference-fix-20261029.apk`

APK SHA-256: `A970E7451766858C97C44A16F81336F4DB505B5D7B37821573B578D5691D88FF`

Instrumentation APK: `F:\app\android_app\delivery\edge-emotion-inference-tests-20261029.apk`

Instrumentation SHA-256: `11A896283414F747890E8E6818C6C6E764B8FE0AF269ADA37A54E9A04C16DE3F`
