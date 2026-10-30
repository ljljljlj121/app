param(
  [string]$Adb = "$env:ANDROID_HOME\platform-tools\adb.exe",
  [string]$Serial = "",
  [string]$Output = "$PSScriptRoot\..\docs\edge-emotion\camera-device.log"
)
$ErrorActionPreference = "Stop"
if (!(Test-Path -LiteralPath $Adb)) {
  throw "adb not found. Pass -Adb with the Android SDK platform-tools adb.exe path."
}
$deviceArgs = @()
if ($Serial) { $deviceArgs = @("-s", $Serial) }
$deviceState = & $Adb @deviceArgs get-state 2>&1
if ($LASTEXITCODE -ne 0 -or $deviceState -ne "device") {
  throw "No selected online Android device. Connect/authorize the phone; pass -Serial if needed."
}
$lines = @("Captured: $(Get-Date -Format o)")
foreach ($property in @("ro.product.manufacturer", "ro.product.model", "ro.build.version.release", "ro.build.version.sdk")) {
  $value = & $Adb @deviceArgs shell getprop $property
  $lines += "${property}: $value"
}
# Snapshot only: do not clear the device log buffer or alter camera state.
$lines += & $Adb @deviceArgs logcat -d -v threadtime -s `
  EdgeEmotionCamera:V EdgeEmotionInference:V Camera2CameraImpl:V CaptureSession:V `
  CameraStateMachine:V DeferrableSurface:V PreviewView:V `
  TextureViewImpl:V SurfaceViewImpl:V AndroidRuntime:E
if ($LASTEXITCODE -ne 0) { throw "Could not read camera logs." }
$lines | Set-Content -LiteralPath $Output -Encoding utf8
Write-Output "Saved camera diagnostics: $([IO.Path]::GetFullPath($Output))"
