# Receipt Drop: http upload server + receipt parser, serving the Android app
# built from src/android/ in the same image. bin/build builds it.
#
#   docker build -t receipt-drop .
#   docker run --rm -p 8080:8080 -v ~/Documents/receipts:/app/data receipt-drop
#
# Photos and parsed receipts land in /app/data. PORT changes the listening port.
# The container runs as the unprivileged "node" user (uid 1000). When the
# mounted folder belongs to another uid, add --user "$(id -u):$(id -g)"
# (docker) or --userns=keep-id (podman).

# ---- stage 1: the apk (JDK 17 + Android build-tools, downloaded by bin/configure)

FROM debian:bookworm-slim AS apk

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/src/android
# The toolchain layer only depends on bin/configure, so a source change
# rebuilds the apk without downloading the toolchain again.
COPY src/android/bin/configure bin/configure
RUN bin/configure
COPY src/android/ ./
RUN bin/build

# ---- stage 2: the server

FROM node:24-bookworm-slim

# convert (ImageMagick), tesseract with ron+eng, python3 for rembg and the
# native QR scanners. Debian's python is externally managed, so the python
# packages go to a venv that is first on PATH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        imagemagick \
        python3 \
        python3-venv \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-ron \
    && rm -rf /var/lib/apt/lists/*

ENV PATH=/opt/venv/bin:$PATH
RUN python3 -m venv /opt/venv \
    && pip install --no-cache-dir \
        'rembg[cpu,cli]==2.0.83' \
        opencv-contrib-python-headless==5.0.0.93 \
        zxing-cpp==3.1.1

WORKDIR /app

COPY src/http/package.json src/http/package-lock.json src/http/
COPY src/parser/package.json src/parser/package-lock.json src/parser/
RUN npm ci --omit=dev --prefix src/http \
    && npm ci --omit=dev --prefix src/parser \
    && npm cache clean --force

COPY bin/ bin/
COPY src/run.js src/run.js
COPY src/http/ src/http/
COPY src/parser/ src/parser/
COPY --from=apk /app/src/android/receipt-drop.apk src/http/public/receipt-drop.apk
COPY --from=apk /app/src/android/apk-version.txt src/http/public/apk-version.txt

# Importing rembg JIT-compiles pymatting's numba functions, ~50 s per fresh
# process, and the compiled cache needs a writable directory, which depends
# on --user. The parser never uses alpha matting, the only user of that code,
# so the JIT is off: the import drops to ~4 s and every start is the same.
ENV NUMBA_DISABLE_JIT=1

# Download the u2net model now and run the same startup checks bin/run runs,
# so a container start downloads nothing and a broken image fails the build.
# U2NET_HOME keeps the model out of $HOME, which depends on --user.
ENV U2NET_HOME=/app/models
RUN mkdir -p data "$U2NET_HOME" \
    && node src/parser/index.js --check-dependencies \
    && chown -R node:node data "$U2NET_HOME" \
    && chmod -R a+rX "$U2NET_HOME"

USER node
ENV PORT=8080
EXPOSE 8080
VOLUME /app/data
WORKDIR /app/data
CMD ["/app/bin/run"]
