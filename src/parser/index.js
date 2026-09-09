// Receipt photo processor: node /app/src/parser [dir] [--watch]
//
// Processes every receipt photo in dir (default: cwd) and exits; with
// --watch it then keeps polling for new photos. For each photo:
// crops to the receipt, fixes perspective, sharpens, decodes the fiscal QR,
// fetches the receipt from sift-mev.sfs.md and saves
// YYYYMMDD_HHMM_merchant_total.jpg + .json. When the QR or the MEV page is
// unavailable it falls back to OCR (tesseract.js) on the cleaned image; the
// sidecar records source "mev" or "ocr" and upgrades to mev when a later
// photo of the same receipt decodes. Originals are never modified.
// A re-shoot of an already-processed receipt overwrites the cleaned copy
// only when it yields more pixels. Progress is logged with time + emoji.
// State lives in <dir>/.receipts_state.json; photos where every extraction
// route failed are flagged once and skipped until their file changes.
// The QR is read by qr_wechat.py first when its scanners are installed
// (pip install opencv-contrib-python-headless zxing-cpp) and by the bundled
// jsQR/ZXing for difficult images; startup requires working native scanners
// and a working rembg model.
const {createWorker} = require('tesseract.js');
const {execFile} = require('child_process');
const {check_dependencies, REMBG_MODEL} = require('./dependencies');
const fs_exists = require('@vbarbarosh/node-helpers/src/fs_exists');
const fs_path_basename = require('@vbarbarosh/node-helpers/src/fs_path_basename');
const fs_path_join = require('@vbarbarosh/node-helpers/src/fs_path_join');
const fs_path_resolve = require('@vbarbarosh/node-helpers/src/fs_path_resolve');
const fs_read_json = require('@vbarbarosh/node-helpers/src/fs_read_json');
const fs_readdir = require('@vbarbarosh/node-helpers/src/fs_readdir');
const fs_rename = require('@vbarbarosh/node-helpers/src/fs_rename');
const fs_rmf = require('@vbarbarosh/node-helpers/src/fs_rmf');
const fs_stat = require('@vbarbarosh/node-helpers/src/fs_stat');
const fs_write_json = require('@vbarbarosh/node-helpers/src/fs_write_json');
const jsQR = require('jsqr');
const zxing = require('@zxing/library');

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const STATE_FILE = '.receipts_state.json';
const TMP_FILE = '.receipts_tmp.jpg';
const OUTPUT_RE = /^\d{8}_\d{4}_[a-z0-9]+_\d+\.jpe?g$/;
const IMAGE_RE = /\.(jpe?g|png)$/i;
const POLL_MS = 3000;
const RETRY_COOLDOWN_MS = 60000;
const MASK_FILE = '.receipts_mask.png';
const WECHAT_HELPER = fs_path_join(__dirname, 'qr_wechat.py');
// RGBA of the long side squared stays inside run()'s 256 MB stdout buffer at
// 6000px; past that a variant would be truncated rather than decoded.
const QR_MAX_LONG_SIDE = 6000;

// Files whose processing hit a transient error (network), name -> retry-at ms.
const retry_cooldown = new Map();

// Preferred engines, each with a built-in fallback: rembg for receipt
// detection (chroma mask otherwise), native tesseract for OCR (tesseract.js
// otherwise), the WeChat scanner ahead of jsQR/ZXing for the fiscal QR.
// zbar was evaluated and rejected: it cannot read these thermal-printed
// fiscal QRs even where jsQR/ZXing succeed.
// Resolved in main() — CommonJS has no top-level await.
let HAS_REMBG = false;
let HAS_TESSERACT = false;
let HAS_WECHAT_QR = false;

const MERCHANT_ALIASES = [
    ['47TH PARALLEL', 'nr1'],
    ['AGRIMATCO', 'agrimatco'],
    ['SUPRATEN', 'supraten'],
];

// tesseract.js worker, created lazily by the OCR fallback.
let ocr_worker = null;

main().catch(function (e) {
    log('💥', e.message);
    process.exit(1);
});

async function main()
{
    const args = process.argv.slice(2);
    const watch = args.includes('--watch');
    const dir = fs_path_resolve(args.find(v => !v.startsWith('--')) || '.');

    await check_dependencies(message => log('🧰', message));
    if (args.includes('--check-dependencies')) return;
    HAS_REMBG = true;
    HAS_WECHAT_QR = true;
    HAS_TESSERACT = await has_command('tesseract');
    if (process.send) process.send({type: 'parser-ready'});

    log('🧾', `receipt-parser starting in ${dir}${watch ? ' (watch mode)' : ''}`);
    log('🧰', `detector: ${HAS_REMBG ? `rembg (${REMBG_MODEL})` : 'chroma mask'} | ocr: ${HAS_TESSERACT ? 'tesseract (ron+eng)' : 'tesseract.js'}`
        + ` | qr: ${HAS_WECHAT_QR ? 'wechat + jsQR/ZXing' : 'jsQR/ZXing'}`);
    const state = await load_state(dir);
    const settling = new Map();

    // Inventory: report every image's status, queue the unprocessed ones.
    // Settle-check is skipped for files that already exist on start.
    const candidates = await list_candidates(dir);
    log('📂', `${candidates.length} image(s) in ${dir}`);
    let queued = 0;
    for (const cand of candidates) {
        const known = state[cand.name];
        if (known && known.size === cand.size && known.mtime === cand.mtime) {
            if (known.status === 'failed') {
                log('⚠️', `  ${cand.name}: previously failed (${known.reason}) — retried only if the file changes`);
            }
            else if (await fs_exists(fs_path_join(dir, known.target))) {
                log('✅', `  ${cand.name}: already processed → ${known.target}`);
            }
            else {
                log('🔁', `  ${cand.name}: output ${known.target} is missing — re-queued`);
                delete state[cand.name];
                queued++;
            }
        }
        else {
            log('⏳', `  ${cand.name}: queued`);
            queued++;
        }
        settling.set(cand.name, cand);
    }
    log('🚀', queued > 0 ? `processing ${queued} image(s)...` : 'nothing to process');
    await scan(dir, state, settling);

    if (!watch) {
        await shutdown_ocr();
        log('🏁', 'done');
        return;
    }

    log('👀', `watching for new photos (every ${POLL_MS / 1000}s, Ctrl-C to stop)...`);
    process.on('SIGINT', async function () {
        await shutdown_ocr();
        log('👋', 'stopped');
        process.exit(0);
    });
    for (;;) {
        await sleep(POLL_MS);
        await scan(dir, state, settling);
    }
}

function log(emoji, message)
{
    const now = new Date().toTimeString().slice(0, 8);
    console.log(`[${now}] ${emoji} ${message}`);
}

function sleep(ms)
{
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function timed_stage(name, stage, fn)
{
    const start = performance.now();
    log('⏱️', `${name}: ${stage}...`);
    try {
        return await fn();
    } finally {
        log('⏱️', `${name}: ${stage} finished in ${((performance.now() - start) / 1000).toFixed(2)}s`);
    }
}

// Run a child process, resolving with its stdout as a Buffer. Child stderr is
// captured, kept out of the tool's log stream, and attached to the error on
// failure. opts.input is written to the child's stdin.
function run(cmd, args, opts = {})
{
    return new Promise(function (resolve, reject) {
        const child = execFile(cmd, args, {maxBuffer: 256 * 1024 * 1024, encoding: 'buffer'},
            function (err, stdout, stderr) {
                if (err) {
                    err.stderr = stderr ? stderr.toString() : '';
                    reject(err);
                }
                else {
                    resolve(stdout);
                }
            });
        child.stdin.on('error', function () { /* child exited before reading stdin */ });
        child.stdin.end(opts.input);
    });
}

function convert(args, opts)
{
    return run('convert', args, opts);
}

async function has_command(cmd)
{
    try {
        await run('which', [cmd]);
        return true;
    } catch (e) {
        return false;
    }
}

// ---- receipt detection ----

function parse_pnm(data)
{
    if (data[0] !== 0x50 || (data[1] !== 0x35 && data[1] !== 0x36)) {
        throw new Error('not a P5/P6 pnm');
    }
    const channels = data[1] === 0x36 ? 3 : 1;
    const fields = [];
    let pos = 2;
    while (fields.length < 3) {
        while (data[pos] === 0x20 || data[pos] === 0x09 || data[pos] === 0x0a || data[pos] === 0x0d) {
            pos++;
        }
        if (data[pos] === 0x23) {
            while (data[pos] !== 0x0a) {
                pos++;
            }
            continue;
        }
        let start = pos;
        while (data[pos] !== 0x20 && data[pos] !== 0x09 && data[pos] !== 0x0a && data[pos] !== 0x0d) {
            pos++;
        }
        fields.push(Number(data.slice(start, pos).toString()));
    }
    pos++;
    return {w: fields[0], h: fields[1], px: data.slice(pos), channels};
}

function largest_component(mask, w, h)
{
    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let out = null;
    for (let start = 0; start < w * h; start++) {
        if (!mask[start] || seen[start]) {
            continue;
        }
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        seen[start] = 1;
        const comp = [];
        while (head < tail) {
            const i = queue[head++];
            comp.push(i);
            const x = i % w;
            const neighbors = [i - w, i + w];
            if (x > 0) {
                neighbors.push(i - 1);
            }
            if (x < w - 1) {
                neighbors.push(i + 1);
            }
            for (const j of neighbors) {
                if (j >= 0 && j < w * h && mask[j] && !seen[j]) {
                    seen[j] = 1;
                    queue[tail++] = j;
                }
            }
        }
        if (out === null || comp.length > out.length) {
            out = comp;
        }
    }
    return out;
}

// Receipt blob via rembg's segmentation mask, downscaled to analysis size.
// Returns null when rembg is unavailable or its mask finds nothing usable.
async function rembg_blob(file, mask_file)
{
    // rembg reads the raw file; bail to the chroma path when EXIF would make
    // its coordinates disagree with the -auto-orient'ed warp space.
    const orientation = (await convert([file, '-format', '%[orientation]', 'info:'])).toString();
    if (orientation !== 'Undefined' && orientation !== 'TopLeft') {
        return null;
    }
    // The mask has occasionally been unreadable right after rembg exits
    // (truncated write); a full second attempt covers that race.
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            await timed_stage(fs_path_basename(file), `rembg ${REMBG_MODEL} (attempt ${attempt})`,
                () => run('rembg', ['i', '-m', REMBG_MODEL, '-om', file, mask_file]));
            const {w, h, px} = parse_pnm(await convert([mask_file, '-resize', '25%', 'pgm:-']));
            const mask = new Uint8Array(w * h);
            for (let i = 0; i < w * h; i++) {
                mask[i] = px[i] > 127 ? 1 : 0;
            }
            const comp = largest_component(mask, w, h);
            if (comp === null || comp.length < (w * h) / 50) {
                return null;
            }
            return {w, h, comp};
        } catch (e) {
            if (attempt === 1) {
                log('⚠️', `${fs_path_basename(file)}: rembg attempt failed (${e.message.split('\n')[0]}) — retrying`);
            }
            if (attempt === 2) {
                log('⚠️', `${fs_path_basename(file)}: rembg mask failed (${e.message.split('\n')[0]}) — using color mask`);
            }
        } finally {
            await fs_rmf(mask_file);
        }
    }
    return null;
}

// Receipt blob via the color heuristic: paper is near-neutral (low chroma)
// even in shadow; wood is orange with hi-lo >= ~29. Relax only when the
// strict mask finds no plausible blob.
async function chroma_blob(file)
{
    const {w, h, px} = parse_pnm(await convert([file, '-auto-orient', '-resize', '25%', 'ppm:-']));
    const THRESHOLDS = [[120, 24], [110, 32], [100, 40]];
    let best = null;
    for (const [lo_min, chroma_max] of THRESHOLDS) {
        const mask = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const r = px[3 * i];
            const g = px[3 * i + 1];
            const b = px[3 * i + 2];
            const lo = Math.min(r, g, b);
            const hi = Math.max(r, g, b);
            if (lo > lo_min && hi - lo < chroma_max) {
                mask[i] = 1;
            }
        }
        const comp = largest_component(mask, w, h);
        if (comp !== null && comp.length >= (w * h) / 10) {
            return {w, h, comp};
        }
        if (comp !== null && (best === null || comp.length > best.length)) {
            best = comp;
        }
    }
    if (best === null || best.length < (w * h) / 50) {
        return null;
    }
    return {w, h, comp: best};
}

async function find_quad(file, mask_file)
{
    const blob = (HAS_REMBG && mask_file && await rembg_blob(file, mask_file)) || await chroma_blob(file);
    if (blob === null) {
        throw new Error('receipt blob not found');
    }
    const {w, h, comp} = blob;

    let tl = null;
    let tr = null;
    let br = null;
    let bl = null;
    for (const i of comp) {
        const p = [i % w, Math.floor(i / w)];
        if (tl === null || p[0] + p[1] < tl[0] + tl[1]) {
            tl = p;
        }
        if (br === null || p[0] + p[1] > br[0] + br[1]) {
            br = p;
        }
        if (tr === null || p[0] - p[1] > tr[0] - tr[1]) {
            tr = p;
        }
        if (bl === null || p[0] - p[1] < bl[0] - bl[1]) {
            bl = p;
        }
    }

    const full = (await convert([file, '-auto-orient', '-format', '%w %h', 'info:'])).toString().split(' ').map(Number);
    const scale = full[0] / w;
    const scaled = [tl, tr, br, bl].map(v => [v[0] * scale, v[1] * scale]);

    // The mask boundary sits inside the true paper edge; push every corner
    // out by a few px along both adjacent edges so the crop never shaves text.
    const MARGIN_PX = 6;
    function away(from, to) {
        const len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
        return [(to[0] - from[0]) / len, (to[1] - from[1]) / len];
    }
    const pushed = scaled.map(function (p, i) {
        const d1 = away(scaled[(i + 1) % 4], p);
        const d2 = away(scaled[(i + 3) % 4], p);
        return [p[0] + (d1[0] + d2[0]) * MARGIN_PX, p[1] + (d1[1] + d2[1]) * MARGIN_PX];
    });

    // Bottom corners detect short where the paper edge casts a shadow, and
    // BON FISCAL prints at the paper's cut edge — extend 1.5% along the sides.
    function extend(p, q) {
        return [q[0] + (q[0] - p[0]) * 0.015, q[1] + (q[1] - p[1]) * 0.015];
    }
    pushed[3] = extend(pushed[0], pushed[3]);
    pushed[2] = extend(pushed[1], pushed[2]);
    return pushed.map(v => [Math.round(v[0]), Math.round(v[1])]);
}

async function warp(file, quad, out_file)
{
    const [tl, tr, br, bl] = quad;
    function dist(a, b) {
        return Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    const w = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
    const h = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
    const dst = [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]];
    const pairs = [];
    for (let i = 0; i < 4; i++) {
        pairs.push(`${quad[i][0]},${quad[i][1]} ${dst[i][0]},${dst[i][1]}`);
    }
    await convert([
        file, '-auto-orient',
        '-define', `distort:viewport=${w}x${h}+0+0`,
        '+distort', 'Perspective', pairs.join(' '), '+repage',
        '-sigmoidal-contrast', '3x50%', '-unsharp', '0x1.2+0.8+0.02',
        '-quality', '92', out_file,
    ]);
    return {w, h};
}

// ---- fiscal QR ----

// Quarter-turns needed to make the QR (and so the receipt) upright, from the
// image-space angle of the QR's top-left -> top-right finder pattern axis.
function quarter_turns(tl, tr)
{
    const angle = Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180 / Math.PI;
    return ((Math.round(angle / 90) % 4) + 4) % 4;
}

function decode_qr_buffer(buf, w, h)
{
    const code = jsQR(new Uint8ClampedArray(buf), w, h);
    if (code !== null && code.data.startsWith('http')) {
        const {topLeftFinderPattern, topRightFinderPattern} = code.location;
        return {url: code.data, rot: quarter_turns(topLeftFinderPattern, topRightFinderPattern)};
    }

    const lum = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
        lum[i] = buf[i * 4];
    }
    const source = new zxing.RGBLuminanceSource(lum, w, h);
    const hints = new Map([[zxing.DecodeHintType.TRY_HARDER, true]]);
    for (const Binarizer of [zxing.HybridBinarizer, zxing.GlobalHistogramBinarizer]) {
        try {
            const result = new zxing.QRCodeReader().decode(new zxing.BinaryBitmap(new Binarizer(source)), hints);
            const text = result.getText();
            if (text.startsWith('http')) {
                // ZXing QR result points: [bottomLeft, topLeft, topRight, ...]
                const points = result.getResultPoints();
                const tl = {x: points[1].getX(), y: points[1].getY()};
                const tr = {x: points[2].getX(), y: points[2].getY()};
                return {url: text, rot: quarter_turns(tl, tr)};
            }
        } catch (e) { /* next binarizer */ }
    }
    return null;
}

// The WeChat scanner reads the file itself and needs no variant sweep, so it
// runs first: on this corpus it alone decodes most receipts, and a hit here
// skips the nine convert() passes below.
async function decode_qr_wechat(src)
{
    if (!HAS_WECHAT_QR) {
        return null;
    }
    try {
        const hit = JSON.parse((await run('python3', [WECHAT_HELPER, src])).toString());
        return {url: hit.url, rot: quarter_turns(hit.tl, hit.tr)};
    } catch (e) {
        return null;
    }
}

async function decode_qr(sources)
{
    const variants = [
        [[], 1], [[], 2], [['-level', '20%,80%'], 2], [['-threshold', '55%'], 2],
        [['-level', '30%,70%'], 3], [['-threshold', '45%'], 3], [['-threshold', '60%'], 3],
        [['-lat', '25x25+5%'], 2], [['-sharpen', '0x2'], 2],
    ];
    for (const src of sources) {
        const decoded = await decode_qr_wechat(src);
        if (decoded !== null) {
            return decoded;
        }
        const [w0, h0] = (await convert([src, '-auto-orient', '-format', '%w %h', 'info:'])).toString().split(' ').map(Number);
        for (const [pre, scale] of variants) {
            const eff = Math.min(scale, QR_MAX_LONG_SIDE / Math.max(w0, h0));
            const w = Math.round(w0 * eff);
            const h = Math.round(h0 * eff);
            try {
                const raw = await convert([src, '-auto-orient', '-colorspace', 'Gray', '-resize', `${w}x${h}!`, ...pre, '-depth', '8', 'rgba:-']);
                const decoded = decode_qr_buffer(raw, w, h);
                if (decoded !== null) {
                    return decoded;
                }
            } catch (e) { /* try next variant */ }
        }
    }
    return null;
}

// ---- MEV receipt page (Laravel + Livewire; needs a browser User-Agent) ----

function parse_initial_data(html)
{
    for (const m of html.matchAll(/wire:initial-data="([^"]*)"/g)) {
        const unescaped = m[1]
            .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        try {
            const json = JSON.parse(unescaped);
            const receipt = json.serverMemo && json.serverMemo.data && json.serverMemo.data.receipt;
            if (Array.isArray(receipt) && receipt.length > 0) {
                return receipt;
            }
        } catch (e) { /* not the receipt component */ }
    }
    return null;
}

function parse_receipt_lines(lines)
{
    const out = {merchant: null, fiscal_code: null, registration_number: null, total: null, date: null, time: null, address: null};
    const flat = [];
    for (const line of lines) {
        flat.push(Array.isArray(line) ? line.map(v => v.trim()).filter(Boolean).join(' ') : line.trim());
    }
    out.merchant = flat[0];
    out.address = flat[2];
    for (const line of flat) {
        let m;
        if ((m = line.match(/^COD FISCAL:\s*(\S+)/))) {
            out.fiscal_code = m[1];
        }
        if ((m = line.match(/^NUMARUL DE .NREGISTRARE:\s*(\S+)/))) {
            out.registration_number = m[1];
        }
        if ((m = line.match(/^TOTAL\s+(\d+[.,]\d{2})$/))) {
            out.total = Number(m[1].replace(',', '.'));
        }
        if ((m = line.match(/^DATA\s+(\d{2})\.(\d{2})\.(\d{4})\s+ORA\s+(\d{2}:\d{2}:\d{2})/))) {
            out.date = `${m[3]}-${m[2]}-${m[1]}`;
            out.time = m[4];
        }
    }
    return out;
}

async function fetch_with_retry(url, opts)
{
    for (let attempt = 1; ; attempt++) {
        try {
            return await fetch(url, opts);
        } catch (e) {
            if (attempt === 3) {
                throw e;
            }
            log('🔁', `fetch failed (${e.message}), retrying in ${attempt * 2}s...`);
            await sleep(attempt * 2000);
        }
    }
}

async function fetch_receipt(qr_url)
{
    const out = {qr_url};
    const old_format = qr_url.match(/\/receipt\/([A-Z]\d+)\/(\d+[.,]\d{2})\/(\d+)\/(\d{4}-\d{2}-\d{2})$/);
    if (old_format !== null) {
        out.url_data = {
            registration_number: old_format[1],
            total: Number(old_format[2].replace(',', '.')),
            receipt_number: old_format[3],
            date: old_format[4],
        };
    }
    const resp = await fetch_with_retry(qr_url, {headers: {'User-Agent': UA, 'Accept-Language': 'ro,en;q=0.7'}});
    out.http_status = resp.status;
    if (resp.ok) {
        const lines = parse_initial_data(await resp.text());
        if (lines !== null) {
            out.mev = parse_receipt_lines(lines);
            out.mev.lines = lines;
        }
    }
    return out;
}

// ---- OCR fallback (used when the QR or the MEV page is unavailable) ----

async function get_ocr_worker()
{
    if (ocr_worker === null) {
        log('🔍', 'loading OCR engine (first run downloads language data)...');
        ocr_worker = await createWorker('eng', 1, {cachePath: __dirname});
    }
    return ocr_worker;
}

async function shutdown_ocr()
{
    if (ocr_worker !== null) {
        await ocr_worker.terminate();
        ocr_worker = null;
    }
}

function parse_ocr_text(text)
{
    const out = {merchant: null, total: null, total_confirmed: false, date: null, time: null};
    const lines = text.split('\n').map(v => v.trim()).filter(Boolean);

    for (const line of lines.slice(0, 8)) {
        const upper = line.toUpperCase();
        if (upper.includes('FARMACI')) {
            out.merchant = 'FARMACIA';
            break;
        }
        const alias = MERCHANT_ALIASES.find(([needle]) => upper.includes(needle));
        if (alias) {
            out.merchant = alias[0];
            break;
        }
    }
    if (out.merchant === null) {
        out.merchant = lines.find(v => /[A-Za-z]{3}/.test(v)) || null;
    }

    // OCR often splits decimals ("429. 49") — allow one space after the separator.
    const AMOUNT = String.raw`(\d+[.,]\s?\d{2})`;
    function amount(s) {
        return Number(s.replace(/\s/g, '').replace(',', '.'));
    }
    let m;
    if ((m = text.match(new RegExp(String.raw`TOTAL(?:\s+LEI)?\s*[.:]*\s*${AMOUNT}`, 'i')))) {
        out.total = amount(m[1]);
    }
    const numerar = (m = text.match(new RegExp(String.raw`NUMERAR(?:\s+LEI)?\s*[.:]*\s*${AMOUNT}`, 'i'))) ? amount(m[1]) : null;
    const rest = (m = text.match(new RegExp(String.raw`REST(?::?\s*NUMERAR)?(?:\s+LEI)?\s*[.:]*\s*${AMOUNT}`, 'i'))) ? amount(m[1]) : null;
    if (out.total !== null && numerar !== null && rest !== null) {
        out.total_confirmed = Math.abs(numerar - rest - out.total) < 0.005;
    }

    function plausible(d, mo) {
        return Number(d) >= 1 && Number(d) <= 31 && Number(mo) >= 1 && Number(mo) <= 12;
    }
    if ((m = text.match(/\b(\d{2})-(\d{2})-(20\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\b/)) && plausible(m[1], m[2])) {
        out.date = `${m[3]}-${m[2]}-${m[1]}`;
        out.time = m[4];
    }
    else {
        const dm = text.match(/\b(\d{2})-(\d{2})-(20\d{2})\b/);
        const tm = text.match(/\b(\d{2}:\d{2}:\d{2})\b/);
        if (dm && tm && plausible(dm[1], dm[2])) {
            out.date = `${dm[3]}-${dm[2]}-${dm[1]}`;
            out.time = tm[1];
        }
    }
    return out;
}

async function recognize_text(input)
{
    if (HAS_TESSERACT) {
        const from_file = typeof input === 'string';
        const text = await run('tesseract',
            [from_file ? input : '-', 'stdout', '-l', 'ron+eng', '--psm', '4'],
            from_file ? {} : {input});
        return text.toString();
    }
    const worker = await get_ocr_worker();
    const {data} = await worker.recognize(input);
    return data.text;
}

async function ocr_receipt(name, tmp, reason, orientations)
{
    return timed_stage(name, 'OCR', () => ocr_receipt_attempts(name, tmp, reason, orientations));
}

async function ocr_receipt_attempts(name, tmp, reason, orientations)
{
    log('🔍', `${name}: falling back to OCR (${reason})`);
    const attempts = [[], ['-colorspace', 'Gray', '-resize', '250%', '-normalize']];
    for (const orient of orientations) {
        const rotate = orient === 0 ? [] : ['-rotate', String(orient)];
        for (const pre of attempts) {
            const args = [...rotate, ...pre];
            const input = args.length === 0 ? tmp : await convert([tmp, ...args, 'png:-']);
            const text = await recognize_text(input);
            const ocr = parse_ocr_text(text);
            if (!ocr.merchant || ocr.total === null || !ocr.date || !ocr.time) {
                continue;
            }
            if (!ocr.total_confirmed) {
                log('⚠️', `${name}: OCR total ${ocr.total} could not be cross-checked (NUMERAR-REST unreadable)`);
            }
            ocr.lines = text.split('\n').map(v => v.trim()).filter(Boolean);
            return {source: 'ocr', reason, rotate: orient, ocr};
        }
    }
    return null;
}

// ---- naming ----

function merchant_slug(name)
{
    const upper = name.toUpperCase();
    if (upper.includes('FARMACI')) {
        return 'farmacy';
    }
    for (const [needle, slug] of MERCHANT_ALIASES) {
        if (upper.includes(needle)) {
            return slug;
        }
    }
    const stripped = upper.replace(/\b(I\.?C\.?S\.?|S\.?R\.?L\.?|S\.?A\.?|Î\.?M\.?)\b/g, ' ');
    const m = stripped.match(/[A-Z0-9]+/);
    return m === null ? 'unknown' : m[0].toLowerCase();
}

function target_base(mev)
{
    const {merchant, total, date, time} = mev;
    if (!merchant || total === null || !date || !time) {
        return null;
    }
    const ymd = date.replace(/-/g, '');
    const hm = time.slice(0, 5).replace(':', '');
    return `${ymd}_${hm}_${merchant_slug(merchant)}_${Math.round(total)}`;
}

// ---- per-file processing ----

async function image_area(file)
{
    const [w, h] = (await convert([file, '-format', '%w %h', 'info:'])).toString().split(' ').map(Number);
    return w * h;
}

async function process_file(dir, name)
{
    const file = fs_path_join(dir, name);
    const tmp = fs_path_join(dir, TMP_FILE);
    log('📸', `${name}: processing...`);

    let quad;
    let size;
    try {
        quad = await timed_stage(name, 'receipt detection', () => find_quad(file, fs_path_join(dir, MASK_FILE)));
        size = await timed_stage(name, 'perspective correction', () => warp(file, quad, tmp));
    } catch (e) {
        log('⚠️', `${name}: ${e.message} — skipped`);
        return {status: 'failed', reason: e.message};
    }
    log('✂️', `${name}: receipt cut out and straightened (${size.w}x${size.h})`);

    let receipt = null;
    let transient = false;
    const decoded = await timed_stage(name, 'QR decoding', () => decode_qr([tmp, file]));
    if (decoded === null) {
        // No QR to orient by: a landscape result must be sideways; portrait may
        // still be upside down — let OCR pick the orientation that parses.
        const orientations = size.w > size.h ? [90, 270] : [0, 180];
        receipt = await ocr_receipt(name, tmp, 'QR undecodable', orientations);
    }
    else {
        if (decoded.rot !== 0) {
            const upright = [0, 1, 2, 3].map(i => quad[(i + decoded.rot) % 4]);
            size = await warp(file, upright, tmp);
            log('🔃', `${name}: rotated ${decoded.rot * 90}° to upright (${size.w}x${size.h})`);
        }
        log('🔳', `${name}: QR → ${decoded.url}`);
        try {
            const fetched = await timed_stage(name, 'MEV lookup', () => fetch_receipt(decoded.url));
            if (fetched.mev) {
                receipt = {source: 'mev', ...fetched};
            }
            else {
                receipt = await ocr_receipt(name, tmp, `MEV page had no receipt data (http ${fetched.http_status})`, [0]);
                transient = true;
            }
        } catch (e) {
            receipt = await ocr_receipt(name, tmp, `MEV fetch failed (${e.message})`, [0]);
            transient = true;
        }
    }
    if (receipt === null) {
        await fs_rmf(tmp);
        if (transient) {
            log('⚠️', `${name}: MEV unreachable and OCR incomplete — will retry in ${RETRY_COOLDOWN_MS / 1000}s`);
            retry_cooldown.set(name, Date.now() + RETRY_COOLDOWN_MS);
            return null;
        }
        log('⚠️', `${name}: no usable QR/MEV data and OCR incomplete — re-shoot closer/sharper; skipped`);
        return {status: 'failed', reason: 'qr/mev/ocr all failed'};
    }

    if (receipt.rotate) {
        await convert([tmp, '-rotate', String(receipt.rotate), '-quality', '92', tmp]);
        if (receipt.rotate !== 180) {
            size = {w: size.h, h: size.w};
        }
        log('🔃', `${name}: rotated ${receipt.rotate}° to upright (per OCR)`);
    }
    delete receipt.rotate;

    const facts = receipt.mev || receipt.ocr;
    const source_emoji = receipt.source === 'mev' ? '🌐' : '📝';
    log(source_emoji, `${name}: ${receipt.source} says ${facts.merchant} | ${facts.date} ${facts.time} | total ${facts.total}`);

    const base = target_base(facts);
    if (base === null) {
        await fs_rmf(tmp);
        log('⚠️', `${name}: extracted data incomplete, cannot build filename — skipped`);
        return {status: 'failed', reason: 'incomplete data'};
    }

    receipt.image = `${base}.jpg`;
    const jpg = fs_path_join(dir, `${base}.jpg`);
    const json_file = fs_path_join(dir, `${base}.json`);
    const new_area = size.w * size.h;
    if (await fs_exists(jpg)) {
        const old_area = await image_area(jpg);
        if (new_area <= old_area) {
            await fs_rmf(tmp);
            log('⏭️', `${name}: ${base}.jpg already exists with equal/better quality (${old_area}px² vs ${new_area}px²) — kept`);
            let old_source = null;
            try {
                old_source = (await fs_read_json(json_file)).source || 'mev';
            } catch (e) { /* missing or unreadable sidecar */ }
            if (old_source === null || (old_source === 'ocr' && receipt.source === 'mev')) {
                await fs_write_json(json_file, receipt);
                log('📄', `${name}: ${base}.json ${old_source === null ? 'was missing — written' : 'upgraded ocr → mev'}`);
            }
            return {status: 'duplicate', target: `${base}.jpg`};
        }
        log('🔄', `${name}: better quality than existing ${base}.jpg (${new_area}px² > ${old_area}px²) — overwriting`);
    }

    await fs_rename(tmp, jpg);
    await fs_write_json(json_file, receipt);
    log('💾', `${name}: saved ${base}.jpg + ${base}.json`);
    return {status: 'done', target: `${base}.jpg`, area: new_area};
}

// ---- directory scanning / watching ----

async function load_state(dir)
{
    try {
        return await fs_read_json(fs_path_join(dir, STATE_FILE));
    } catch (e) {
        return {};
    }
}

async function save_state(dir, state)
{
    await fs_write_json(fs_path_join(dir, STATE_FILE), state);
}

async function list_candidates(dir)
{
    const out = [];
    for (const name of (await fs_readdir(dir)).sort()) {
        if (name.startsWith('.') || !IMAGE_RE.test(name) || OUTPUT_RE.test(name)) {
            continue;
        }
        try {
            const stat = await fs_stat(fs_path_join(dir, name));
            if (stat.isFile()) {
                out.push({name, size: stat.size, mtime: stat.mtimeMs});
            }
        } catch (e) { /* vanished between readdir and stat */ }
    }
    return out;
}

async function scan(dir, state, settling)
{
    let processed = 0;
    for (const cand of await list_candidates(dir)) {
        const known = state[cand.name];
        if (known && known.size === cand.size && known.mtime === cand.mtime) {
            // Self-heal: a deleted output means the work needs redoing.
            if (known.status === 'failed' || await fs_exists(fs_path_join(dir, known.target))) {
                continue;
            }
            log('🔁', `${cand.name}: output ${known.target} is missing — re-queued`);
            delete state[cand.name];
        }
        if ((retry_cooldown.get(cand.name) || 0) > Date.now()) {
            continue;
        }

        // Only touch a file once its size/mtime survived one full poll interval —
        // it may still be uploading.
        const pending = settling.get(cand.name);
        if (!pending || pending.size !== cand.size || pending.mtime !== cand.mtime) {
            if (!pending && !retry_cooldown.has(cand.name)) {
                log('🆕', `${cand.name}: new file detected — queued`);
            }
            settling.set(cand.name, cand);
            continue;
        }
        settling.delete(cand.name);

        const result = await process_file(dir, cand.name);
        if (result !== null) {
            state[cand.name] = {size: cand.size, mtime: cand.mtime, ...result};
            await save_state(dir, state);
        }
        processed++;
    }
    return processed;
}
