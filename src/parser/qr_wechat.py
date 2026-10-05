#!/usr/bin/env python3
# Native fiscal-QR decoders, called by index.js ahead of its jsQR/ZXing sweep.
#
# Two scanners, because they fail on different receipts:
#
#   WeChat    jsQR and ZXing locate a code by scanning for the 1:1:3:1:1 run
#             that crosses a finder pattern. An under-inked thermal head prints
#             those finders hollow, the run reads as 1:1:1:1:1:1:1, and
#             detection never starts — thresholding alone does not recover it,
#             closing the gaps does (INKED). WeChat finds the code another way
#             and still reads most of those.
#   zxing-cpp the same algorithm as index.js's @zxing/library, but the C++
#             implementation: it reads thermal receipts the JS port gives up on.
#
# Between them they cover every receipt either one can read.
#
#   qr_wechat.py --check          exit 0 when both scanners are available
#   qr_wechat.py <image>          print {"url","tl","tr"} on stdout, exit 1 if unread
#
# Needs opencv-contrib-python-headless (plain opencv-python has no
# cv2.wechat_qrcode) and zxing-cpp. WeChat runs without its Caffe models: they
# are optional, and on this corpus the model-free detector reads one receipt
# more than they do.
import json
from pathlib import Path
import sys

# scales to feed zxing-cpp, relative to the source; a code missed at one
# sampling grid is often clean at another
SCALES = (0.72, 1.0, 2.0)

# (cut, radius) for a hollow-printed code, tried only when the plain image
# fails: levels stretched, cut near paper white so faint ink is dark, then the
# gaps inside each module closed with a disk of that radius
INKED = ((0.55, 2), (0.55, 3), (0.6, 2), (0.6, 3))


def hit(url, tl, tr):
    return {'url': url,
            'tl': {'x': float(tl[0]), 'y': float(tl[1])},
            'tr': {'x': float(tr[0]), 'y': float(tr[1])}}


def read_wechat(cv2, image):
    texts, corners = cv2.wechat_qrcode.WeChatQRCode().detectAndDecode(image)
    for text, quad in zip(texts, corners):
        # corners run top-left, top-right, bottom-right, bottom-left in the
        # code's own frame, so tl->tr carries the rotation index.js needs
        if text.startswith('http'):
            return hit(text, quad[0], quad[1])
    return None


def read_zxing(cv2, zxingcpp, image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    for scale in SCALES:
        scaled = gray if scale == 1.0 else cv2.resize(gray, None, fx=scale, fy=scale,
                                                      interpolation=cv2.INTER_CUBIC)
        for binarizer in (zxingcpp.Binarizer.LocalAverage, zxingcpp.Binarizer.GlobalHistogram):
            for code in zxingcpp.read_barcodes(scaled, formats=zxingcpp.BarcodeFormat.QRCode,
                                               try_rotate=True, try_downscale=True,
                                               binarizer=binarizer):
                if code.text.startswith('http'):
                    at = code.position
                    return hit(code.text,
                               (at.top_left.x / scale, at.top_left.y / scale),
                               (at.top_right.x / scale, at.top_right.y / scale))
    return None


def fill_ink(cv2, numpy, image, cut, radius):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    lo, hi = numpy.percentile(gray, (2, 99))
    stretched = numpy.clip((gray.astype(numpy.float32) - lo) * 255 / max(hi - lo, 1), 0, 255).astype(numpy.uint8)
    _, bw = cv2.threshold(stretched, int(255 * cut), 255, cv2.THRESH_BINARY)
    disk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    # white is the foreground to OpenCV: opening it closes the dark modules
    return cv2.cvtColor(cv2.morphologyEx(bw, cv2.MORPH_OPEN, disk), cv2.COLOR_GRAY2BGR)


def variants(cv2, numpy, image):
    yield image
    for cut, radius in INKED:
        yield fill_ink(cv2, numpy, image, cut, radius)


def main():
    args = sys.argv[1:]
    if not args:
        return 2

    import cv2
    import numpy
    import zxingcpp
    if args[0] == '--check':
        # Decode a known local fixture with each engine. Importing plain
        # OpenCV alone does not establish that WeChat is actually available.
        image = cv2.imread(str(Path(__file__).with_name('fixtures') / 'qr-check.png'))
        if image is None:
            raise RuntimeError('native QR self-test image is missing')
        expected = 'https://receipt-camera.invalid/check'
        for label, read in [('WeChat', lambda: read_wechat(cv2, image)),
                            ('zxing-cpp', lambda: read_zxing(cv2, zxingcpp, image))]:
            result = read()
            if result is None or result['url'] != expected:
                raise RuntimeError(label + ' failed the QR decode self-test')
        return 0

    image = cv2.imread(args[0])
    if image is None:
        return 1

    for variant in variants(cv2, numpy, image):
        for read in (read_wechat, lambda c, i: read_zxing(c, zxingcpp, i)):
            out = read(cv2, variant)
            if out is not None:
                print(json.dumps(out))
                return 0
    return 1


if __name__ == '__main__':
    sys.exit(main())
