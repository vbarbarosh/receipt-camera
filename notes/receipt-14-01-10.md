# Why the 2026-09-07 14:01:10 receipt failed

The image is readable to a person. Its failure is more specific than the old
generic “re-shoot closer/sharper” message: QR detection succeeds but decoding
fails checksum validation, and OCR cannot reliably recover the required
fields.

## Supplied log

```text
[14:03:42] receipt cut out and straightened (844x3854)
[14:04:48] falling back to OCR (QR undecodable)
[14:05:26] no usable QR/MEV data and OCR incomplete
```

This interval contains **66 seconds of QR attempts and 38 seconds of OCR**.
rembg had already finished before the first line. Switching to a faster rembg
model addresses the earlier segmentation step, not those 104 seconds.

## Image and decoder evidence

- Original photo, supplied with the report and not kept in this repository: 3120 × 4160 pixels; EXIF exposure 30 ms, ISO 541.
- Receipt text visibly shows the merchant, total, cash, change, date, and time. These are human readings from the supplied image, not successfully extracted fiscal API data.
- An unscaled crop of the original QR shows a visible fold through the grid, with local geometric distortion. This is a plausible contributor, not a proven exclusive cause. A global four-corner perspective warp does not remove a local paper fold.
- ZXing C++ with `return_errors=True` located the main code at approximately `86x80 386x102 378x400 79x379` in that crop and reported **`ChecksumError @ QRDecoder.cpp:337`**, with no valid decoded text. Spurious additional candidates also failed checksum validation; their partial text was not used.
- OpenCV's standard QR detector reported detection success, but curved QR decoding returned an empty string. WeChat and ZXing C++ failed on the original and on lower-half/lower-third crops of both the original and the straightened image.

## OCR evidence

Rebuilt a crop using the explicit U2Net model: **828 × 3846**. Visual
inspection confirms the total, footer, date/time, and QR are retained; the
bottom was not cut away.

- Current `ron+eng --psm 4` OCR misreads one digit of the total, reads cash correctly, and garbles the change. It omits the footer date/time entirely. The parser requires merchant, total, date, and time, so this output is incomplete. The absence of date/time is enough to reject it; total cross-check failure alone currently produces a warning.
- Diagnostic `--psm 6` reads the total correctly, but garbles the time and the change.
- Diagnostic `--psm 11` gets the total and time, but reads the year as **0026**. The parser correctly rejects that date rather than inventing the missing century.

A full local rerun with U2Net and native scanners still failed this particular
image: detection **4.61 s**, perspective correction **1.80 s**, QR sweep
**108.96 s**, OCR **98.13 s**. Diagnostic work overlapped some of this run, so
these timings are not a controlled comparison with the user's machine. The
failure itself is reproducible.

## Outcome and remaining work

Kept this investigation separate from guessing receipt data. No manual
correction was written into the user's receipts or parser state. The parser
now uses fast U2Net and requires working rembg/native scanners at startup, but
this image demonstrates that native scanners alone do not guarantee a valid
QR.

Potential follow-up improvements are local fold correction, bounded QR
fallback work, and OCR of separate total/footer regions. Changing OCR page
segmentation alone did not recover all required fields in this check.
Flattening the lower part of the receipt would specifically address the
visible distortion, rather than relying only on increasing resolution or
sharpening.
