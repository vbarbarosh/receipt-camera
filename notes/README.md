# Receipt Drop findings

- [Parser performance](parser-performance.md): rembg default-model change, CPU benchmarks, native QR dependencies, startup checks, and validation.
- [Receipt 14-01-10 failure](receipt-14-01-10.md): detected QR with checksum failure, paper fold, and incomplete/incorrect OCR fields.
- [Android image blur](android-image-blur.md): capture focus and motion issues, fixes, APK validation, and phone checks.

The parser explicitly uses **U2Net** by default. On the tested receipt, warm
prediction took approximately **1.1 seconds**, versus **28–32 seconds** for
BRIA. Full parsing of two successfully decoded receipts took approximately **7
and 9 seconds** in the measured runs. Difficult QR/OCR fallbacks can still
take longer.

Startup requires a working rembg model and both native QR scanners. Restart
`bin/run` to load the changes. Dependency validation can also be run
separately with `node src/parser/index.js --check-dependencies`.
