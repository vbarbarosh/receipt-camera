# Server

Needs Node.js. One-time: run `bin/configure` — it installs the npm
dependencies and, when missing, the apk build toolchain (JDK 17 +
Android build-tools/platform, ~350 MB into `src/android/toolchain/`).

`bin/run` starts the http server and the receipt parser together in the
current directory; Ctrl-C stops both. Server only:
`node /path/to/receipt-drop/src/http/index.js`. Photos are saved to the
directory you start it from, or to an explicit folder: `node index.js
~/Documents/receipts`. Different port: `PORT=9000 node index.js`. The startup
log prints the URL(s) to open on the phone.
