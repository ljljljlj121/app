# Camera startup fix (2026-10-29)

## Evidence and diagnosis

The reported screenshot shows `CameraX error 4`, a black preview and zero
analyzed frames. The exact bundled CameraX 1.5.0-rc01 `CameraState` constants
identify 4 as `ERROR_STREAM_CONFIG`.

The official version-matched Camera2 source reports this error when opening a
capture session fails (excluding cancellation and closed-surface handling).
The numeric error alone does not identify the phone's underlying exception.

The local native view had a concrete layout defect: it used ExpoView's default
`shouldUseAndroidLayout = false` while hosting a PreviewView. PreviewView
creates an internal TextureView after the surface request. ExpoView documents
that React Native does not otherwise remeasure/relayout such native children
after requestLayout. A missing TextureView layout can prevent surface creation.
This is the leading explanation; no device stack trace was available to prove
that it caused this particular phone's session failure.

## Changes

- Enable ExpoView's native layout scheduling and explicitly measure its preview
  container at the dimensions supplied by React Native.
- Log surface requests, dimensions, camera states and full error exceptions under
  `EdgeEmotionCamera`; show the error name, lens, dimensions and exception chain.
- Let CameraX handle its recoverable camera errors instead of immediately
  unbinding them. Critical errors still stop analysis and clear the current tag.
- Offer a camera retry action that destroys the old view and starts a new session.
- Track/cancel the camera remount delay when switching lens, retrying or leaving.
- Keep the model, preprocessing, stream resolution policy and dependency versions.

## Device follow-up

Install the named camera-fix APK from `delivery`, then open the emotion page.
Check front/rear preview, analysis frame counts, repeated collection/emotion
navigation, rotation, background/resume, pause/resume and retry behavior.

If startup still fails, reproduce it and capture the detailed message and logs:

```powershell
cd F:\app\android_app
.\scripts\collect_emotion_camera_logs.ps1 -Adb F:\aliveriver\Android\SDK\platform-tools\adb.exe
```

This reads the existing log buffer without clearing it. With multiple online
devices, pass `-Serial`. No image/video is captured by this script.

At build time no physical device was connected; the only adb entry was an
offline emulator. Build/test success does not establish successful phone camera
startup, inference parity, performance or long-run stability.

## Executed checks

- TypeScript: passed.
- Existing JS regression checks: 5/5 passed.
- Native EmotionMath unit tests: 4/4 passed.
- Android instrumentation Kotlin compilation: passed (tests not executed).
- Release APK build: passed.
- APK v2 signature: verified.
- Embedded ONNX SHA-256: verified unchanged.
- New surface diagnostic string in APK DEX: verified.
- Diagnostic PowerShell script syntax and git diff whitespace checks: passed.

APK: `F:\app\android_app\delivery\app-emotion-camera-fix-20261029.apk`

SHA-256: `AC3371606094B7A70439340152CBD4A8DF0DB2FB8BA0AD9D2492D418314255EE`
