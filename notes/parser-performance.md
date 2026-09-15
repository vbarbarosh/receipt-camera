# Parser performance investigation — 2026-09-07

The installed rembg changed the default segmentation model. The parser used
`rembg i -om`, allowing a package upgrade to change both speed and
segmentation behavior without a source change. The parser now explicitly
requests `u2net`, with `REMBG_MODEL` available for deliberate comparisons.

## Evidence and scope

- Local environment: rembg 2.0.83, ONNX Runtime 1.29.0, Python 3.12, CPU execution. Installed `rembg/commands/i_command.py` and `session_factory.py` default to `bria-rmbg`.
- Downloaded the rembg 2.0.67 wheel without installing it and inspected the same files: both default to `u2net`. The user's exact former version is not known; 2.0.67 is a verified historical reference, not a claimed reconstruction of that environment.
- Installed BRIA input resolution is 1024 × 1024; U2Net is 320 × 320. The BRIA model file is approximately 977 MiB versus 168 MiB for U2Net. This is a different model and substantially more work, not evidence that an unchanged U2Net became slower.
- Every receipt launches a separate rembg process, which imports Python dependencies and constructs a new ONNX session. The parser processes photos sequentially, so segmentation latency accumulates across the queue. A failed attempt could previously repeat silently; retries are now logged.
- The only supplied logs were two `phone.log` files containing Android camera events; there was no parser stdout log. The newer camera log reports bursts around 390 ms; it does not measure server-side parsing. The supplied `.receipts_state.json` records one completed receipt and one failed extraction, but contains no stage durations. An empty `.receipts_mask.png` next to it is consistent with an unfinished mask write; it is not proof of the cause of delay. None of these inputs are kept in this repository.
- The native QR helper initially fails its check because `zxingcpp` is missing. Installed OpenCV 5.0.0 also lacks `wechat_qrcode`. The resulting fallback tries up to nine image variants for each of the cropped and original images using JavaScript QR decoders. This is an additional potential bottleneck after segmentation, especially for unreadable QR codes.

## Measurements

Benchmarks used a temporary copy of the same supplied photo, the 14:00:23 shot, with output written to a temporary directory. Original photos, saved receipts, and parser state were untouched. Models run sequentially to avoid competing benchmark workloads.

- Original implicit BRIA CLI: **95.421 s** on the first measured invocation, with its model already downloaded. This includes process startup and first-use dependency initialization; do not interpret it as pure inference time.
- Explicit U2Net CLI, including its first model download: **12.359 s**.
- Explicit U2Net CLI, model/dependency caches warm: **8.100 s**.

Separate warm profiling using `new_session(model)` and two `session.predict(photo)` calls isolated the model cost:

| Stage | BRIA | U2Net |
| --- | ---: | ---: |
| Import | 1.950 s | 1.085 s |
| Session construction | 12.528 s | 0.461 s |
| First prediction | 28.095 s | 1.060 s |
| Second prediction, same session | 32.220 s | 1.088 s |

Both sessions reported `CPUExecutionProvider`. Even after startup, BRIA prediction took approximately 26–30 times as long on this receipt. No rembg or ONNX Runtime downgrade was needed to recover U2Net performance. These are local single-image measurements, not a corpus-wide speed guarantee.

For an easy receipt, JavaScript QR fallback decoded the existing crop in 0.760 s, so missing native scanners do not explain every slow receipt.

For the difficult 14:00:32 original, the full JavaScript variant sweep took **79.927 s** and found no QR. Native decoding of that original alone also failed, after **4.561 s**. However, native decoding of the newly straightened U2Net crop succeeded in **0.61 s** in the full parser. These inputs differ, so this is evidence for the combined crop/native path, not a same-image decoder speedup claim. Native decoding of the easy existing crop took **0.178 s** and succeeded.

Full pipeline verification on two copied receipts, with the new model selection and native dependencies:

| Stage | 14:00:23 shot | 14:00:32 shot |
| --- | ---: | ---: |
| rembg command (included in detection below) | 3.63 s | 4.30 s |
| Complete receipt detection | 4.94 s | 5.82 s |
| Perspective correction | 1.79 s | 2.70 s |
| QR decoding | 0.28 s | 0.61 s |
| MEV lookup | 0.22 s | 0.13 s |
| Sum of top-level stages | **7.23 s** | **9.26 s** |

Both saved a cleaned JPEG and MEV-backed JSON. The first matched the previously saved receipt. The second, previously marked failed in the supplied state, resolved to a complete merchant, date, and total. Both crops retained the receipt and readable QR. Timing varies with cache and CPU load: the CLI measurements and later pipeline runs are separate observations.

## Changes

- Use `rembg i -m u2net -om` by default and show the model in the startup log. `REMBG_MODEL=bria-rmbg` restores the newer model for an intentional comparison without downgrading packages.
- Log starts and elapsed durations for receipt detection, individual rembg attempts, perspective correction, QR decoding, OCR, and MEV lookup. Log the first failed rembg attempt before retrying.
- Document model selection, native QR dependencies, and `bin/run 2>&1 | tee parser.log` in `docs/server.md`.
- Install `zxing-cpp` 3.1.1 and replace the user-site plain OpenCV 5.0.0.93 wheel with the matching `opencv-contrib-python-headless` 5.0.0.93 wheel. This enables the already implemented fast native QR route. Fix `qr_wechat.py --check` to verify that the WeChat module exists, rather than accepting any OpenCV build.
- Use the existing `convert ... -format ... info:` path for orientation and dimensions. This environment's `identify` wrapper incorrectly invokes bare `magick`, causing the initial pipeline smoke test to fail before segmentation. This was a separate compatibility problem, not the measured model slowdown.
- As subsequently requested, require working rembg and both native QR scanners at startup. Each scanner decodes a bundled local QR; rembg runs the explicitly configured model on a synthetic image and its mask is decoded and dimension-checked. The combined launcher waits for parser readiness before opening HTTP. Direct parser/server entry points also validate dependencies. No silent dependency fallback at startup is allowed.

## Validation and artifacts

- `node --check src/parser/index.js`, Python syntax parsing, native scanner `--check`, and `git diff --check` passed.
- `node src/parser/tests/startup.test.js`: eight refusal-path checks passed (scanner failure, rembg failure/missing command, invalid mask; parser, launcher, and direct HTTP entry points). A real combined-launcher smoke test confirmed HTTP opens after checks pass and SIGTERM shuts down both children cleanly.
- The full parser completed successfully on two temporary receipt copies. No OCR fallback was needed for either, so OCR elapsed logging is present but not exercised in that successful run.
- No existing parser/server process was running in this environment to restart. Restart `bin/run` in the actual receipt directory to load the code and installed native dependencies. Existing files marked failed in `.receipts_state.json` remain skipped until changed; they were deliberately not reprocessed in the user's directory during benchmarking.

The later user-supplied log for the 14:01:10 shot showed 66 seconds in QR fallback and 38 seconds in OCR after segmentation had finished. This image has a separate reproducible decode/OCR failure; see `notes/receipt-14-01-10.md` for the checksum error, visual inspection, and transcripts. Fast rembg alone cannot eliminate its fallback time.

The first run of a model can download its weights. The normal rembg command still creates a new session per receipt; a persistent worker could remove repeated startup cost later. Thread count may also affect inference; ONNX Runtime normally creates intra-op workers based on physical cores. Thread settings were not changed as part of the model correction. [ONNX Runtime threading](https://onnxruntime.ai/docs/performance/tune-performance/threading.html)
