# Android app (one-tap capture)

The web page links to `receipt-drop.apk` — a tiny native Android app (sources
in `src/android/`, rebuilt with `bin/build`, no Gradle needed). It shows a live
viewfinder and takes full-quality stills at one tap per receipt, no confirm
step, uploading to the same server. Install: tap the link on the phone, allow
Chrome to install unknown apps when Android asks (one-time), open, grant camera
access. The "server" button in its top-right corner sets the upload address
(default `http://192.168.100.44:8080`).

The app refuses to start without the server: on launch it fetches
`/apk-version.txt` — reachable and current means the camera opens; unreachable
shows a retry screen instead (photos can never be shot into the void). When the
server holds a newer apk, the app offers "Update now": it downloads the apk
itself and opens the system installer — two taps, no browser. Publishing an
update = run `bin/build` (bump `versionCode` in AndroidManifest.xml first), then
copy the fresh `receipt-drop.apk` **and** `apk-version.txt` into
`src/http/public/`. The `keystore` file must never be lost — updates only install
over the old version when signed with the same key.
