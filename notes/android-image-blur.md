# Android image blur investigation — 2026-09-07

Implemented a capture-side fix and built version 20 (2.9). Image-quality
improvement still needs a comparison on the physical phone; compilation and
policy tests cannot establish optical sharpness.

## Evidence

- Inspected `src/android/src/app/receiptdrop/MainActivity.java`, the supplied `phone.log`, and EXIF from all seven supplied original photos from 2026-09-07. Each original is 3120 × 4160, with a 0.03-second exposure and ISO 316–364. The capture log reports a 4160 × 3120 JPEG stream; portrait output explains the reversed dimensions. There is no evidence here of saving a low-resolution preview instead of a still.
- The supplied `phone.log` labels the historical capture run `apk-19`. It reports selected burst sharpness scores of 931, 1066, 981, 774, 908, 631, and 847. Three are below the source's existing 900 threshold. These are scene-dependent scores on an image reduced eightfold; they are not a calibrated blur measurement.
- The source accepted `NOT_FOCUSED_LOCKED` as a successful focus lock, and captured anyway after a 900 ms timeout or request exception. Android defines that state as failed autofocus. Null/inactive preview metadata could also count as focus. These are concrete source defects, but the old log has no focus-lock events, so it does not prove which focus path the installed binary executed. [Android autofocus definitions](https://developer.android.com/reference/android/hardware/camera2/CameraMetadata#CONTROL_AF_STATE_NOT_FOCUSED_LOCKED)
- The movement detector compared each smoothed receipt box with the immediately previous box. A slow glide could stay below the per-frame threshold indefinitely while accumulating substantial movement.
- All sample exposures were 30 ms. This leaves time for hand motion, although EXIF alone cannot separate motion blur, missed focus, lens softness, and noise reduction. Optical stabilization was not explicitly requested. Android describes OIS as compensating for small camera movements during capture. [OIS request documentation](https://developer.android.com/reference/android/hardware/camera2/CaptureRequest#LENS_OPTICAL_STABILIZATION_MODE)

## Changes

- Select supported autofocus modes. Use a fresh AUTO scan where available, keep the same AF mode in the repeating preview and still burst to preserve the lock, then restore normal preview AF afterward. Cameras exposing only AF OFF can still capture without waiting for an impossible lock.
- Require a confirmed `FOCUSED_LOCKED` result from the current tagged attempt. Ignore old, missing, inactive, scanning, and merely passive results. Failed focus, timeout (now 1800 ms), and trigger exceptions cancel the shot and rearm automatic capture instead of uploading an unconfirmed shot. Manual capture can be retried with the shutter.
- Clear stale focus readiness when the lens loses focus. Recheck sensor/box stillness when automatic capture starts and after focus completes.
- Retain a receipt-box anchor until cumulative position or size movement crosses the existing threshold. This preserves jitter tolerance while catching slow drift.
- Request OIS in preview, focus, and still requests only if advertised. Defer torch changes during focus/burst so restarting preview cannot reset the AF mode mid-shot. Keep the burst busy until both JPEG delivery and capture callbacks finish.
- Cancel pending focus work during camera shutdown on the camera handler. Add actual still-result logging for exposure, ISO, focus state/distance, and OIS, so future diagnosis can use captured settings instead of preview estimates.
- Bump the manifest to version 20 / 2.9 and refresh the APK and version marker in `src/http/public/` for the existing update flow.

## Validation

- `src/android/bin/test`: passed 19 JVM regression checks covering failed versus successful focus, stale/duplicate/cancelled results, missing metadata, gradual positional/scale drift, jitter, and receipt reappearance.
- `src/android/bin/build`: compiled, dexed, aligned, and signed successfully using the existing local JDK 17 / Android 34 toolchain. Only the existing deprecated-API compiler notice was emitted; no package installation was needed.
- APK verification passed v2/v3 signing. The new APK has the same signing certificate as the previously served APK, allowing an in-place update.
- `git diff --check`: passed.
- No physical-camera test was performed. No ADB or emulator executable was found in PATH or the inspected toolchain locations.

## Remaining checks on the phone

1. Install version 20 through the existing server update prompt. Photograph the same receipt at the same distance and light, several times; compare fine text and QR edges at full resolution.
2. Deliberately move too close or point at a featureless surface: failed focus should not produce a shutter click/upload. Move back, hold steady, and verify capture recovers. Repeat with manual capture and auto disabled.
3. Glide slowly over a receipt: automatic capture should wait until movement stops. Move during the focus scan and verify the shot is cancelled. Move to another receipt and verify AF refocuses.
4. Toggle the torch during focusing and test pause/resume. Inspect `focus-lock`, `focus-lock-failed`, `still-result`, and `burst-scores` in the new phone log.

Exposure tuning remains a separate hardware check. Existing still-only negative exposure compensation may need several frames to converge; the existing manual branch can lengthen exposure when ISO hits its ceiling. Neither guarantees a short shutter. The automatic torch threshold remains 60 ms, so it does not illuminate the supplied 30 ms cases. These controls were not retuned without new device results. [Exposure compensation convergence](https://developer.android.com/reference/android/hardware/camera2/CaptureRequest#CONTROL_AE_EXPOSURE_COMPENSATION)

The existing eightfold-downsampled sharpness score, HIGH_QUALITY noise reduction, and RGB_565 brightening/re-encoding are additional possible quality limitations. They were left unchanged because these samples do not isolate their contribution. Supplied photos, parsed receipts, and logs were left unmodified; they are not kept in this repository.
