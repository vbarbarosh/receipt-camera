# Server

Needs docker or podman for `bin/run`, and Node.js to run the pieces
separately. One-time: run `bin/configure` — it installs the npm
dependencies and, when missing, the apk build toolchain (JDK 17 +
Android build-tools/platform, ~350 MB into `src/android/toolchain/`) — then
`bin/build`, which builds the `receipt-camera` image.

`bin/run` starts the http server and the receipt parser together in the
current directory, inside the image, on the laptop's own network; Ctrl-C stops
both. The files it writes belong to you. Server only:
`node /path/to/receipt-camera/src/http/index.js`. Photos are saved to the
directory you start it from, or to an explicit folder: `node index.js
~/Documents/receipts`. Different port: `PORT=9000 node index.js`. The startup
log prints the URL(s) to open on the phone.

Receipt segmentation explicitly uses rembg's `u2net` model. Recent rembg
versions default to the heavier `bria-rmbg`; upgrading rembg should not silently
change the receipt model. To compare another model, run
`REMBG_MODEL=bria-rmbg bin/run`. A model may download on its first use.

The parser logs elapsed time for segmentation, perspective correction, QR
decoding, OCR, and MEV lookup. Save a session log with
`bin/run 2>&1 | tee parser.log`.

Startup requires working rembg and both native QR scanners (WeChat and
zxing-cpp). Before the upload server opens, the parser runs the selected rembg
model on a small test image and makes each native scanner decode a bundled QR.
A missing command, broken backend, unusable model, or failed decoder check exits
with an error and installation guidance. Direct parser and server startup also
perform the checks. Run only the checks with
`node src/parser/index.js --check-dependencies`.

Install the Python dependencies in the environment used by `python3` and
`rembg`: `python3 -m pip install 'rembg[cpu,cli]' opencv-contrib-python-headless zxing-cpp`.
Use a virtual environment if your Python installation requires one. Use the
contrib OpenCV wheel instead of the plain wheel; they share the `cv2` module.
ImageMagick must also be installed. The initial model check allows up to two
minutes for loading/downloading; rerun after fixing a reported failure.

## As a service

A service manager runs the image as is, without `bin/run`:

    docker run -p 8080:8080 -v ~/Documents/receipts:/app/data --userns=keep-id receipt-camera

With docker, `-u "$(id -u):$(id -g)"` replaces `--userns=keep-id`. The receipts
folder is the `/app/data` volume and `PORT` is the listening port. The port
opens about 6 s after the start, once the startup checks pass. SIGTERM stops
it at once. A photo cut off mid-parse is parsed again on the next start, so
the service can be stopped whenever it is idle. Run one instance per folder:
two parsers on one folder race on `.receipts_state.json`. Behind `-p`, the
startup log prints the container's address, not the one the phone opens.
