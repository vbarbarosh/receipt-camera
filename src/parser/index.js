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
// only when it yields more pixels. Progress is logged as [group_uid][sender]
// lines, one group per photo.
// State lives in <dir>/.receipts_state.json; photos where every extraction
// route failed are flagged once and skipped until their file changes.
// The QR is read by qr_wechat.py first when its scanners are installed
// (pip install opencv-contrib-python-headless zxing-cpp) and by the bundled
// jsQR/ZXing for difficult images; startup requires working native scanners
// and a working rembg model.
const cli = require('@vbarbarosh/node-helpers/src/cli');
const dependencies_check = require('./dependencies_check');
const format_log_value = require('../helpers/format_log_value');
const format_seconds = require('../helpers/format_seconds');
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
const log = require('../helpers/log');
const log_group_spawn = require('../helpers/log_group_spawn');
const rembg_model = require('./rembg_model');
const zxing = require('@zxing/library');

const {createWorker} = require('tesseract.js');
const {execFile} = require('child_process');

const user_agent = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const state_file = '.receipts_state.json';
const tmp_file = '.receipts_tmp.jpg';
const output_re = /^\d{8}_\d{4}_[a-z0-9]+_\d+\.jpe?g$/;
const image_re = /\.(jpe?g|png)$/i;
const poll_ms = 3000;
const retry_cooldown_ms = 60000;
const mask_file = '.receipts_mask.png';
const wechat_helper = fs_path_join(__dirname, 'qr_wechat.py');
// RGBA of the long side squared stays inside command_run()'s 256 MB stdout
// buffer at 6000px; past that a variant would be truncated rather than decoded.
const qr_max_long_side = 6000;

// Files whose processing hit a transient error (network), name -> retry-at ms.
const retry_cooldown = new Map();

// Preferred engines, each with a built-in fallback: rembg for receipt
// detection (chroma mask otherwise), native tesseract for OCR (tesseract.js
// otherwise), the WeChat scanner ahead of jsQR/ZXing for the fiscal QR.
// zbar was evaluated and rejected: it cannot read these thermal-printed
// fiscal QRs even where jsQR/ZXing succeed.
// rembg and the WeChat scanner are checked at startup; tesseract is resolved
// in main() — CommonJS has no top-level await.
let has_tesseract = false;

const merchant_aliases = [
    ['47TH PARALLEL', 'nr1'],
    ['AGRIMATCO', 'agrimatco'],
    ['SUPRATEN', 'supraten'],
];

// tesseract.js worker, created lazily by the OCR fallback.
let ocr_worker = null;

cli(main);

async function main()
{
    const args = process.argv.slice(2);
    const watch = args.includes('--watch');
    const dir = fs_path_resolve(args.find(v => !v.startsWith('--')) || '.');
    const root_uid = log_group_spawn();

    await dependencies_check(root_uid);
    if (args.includes('--check-dependencies')) {
        return;
    }
    has_tesseract = await is_command_available('tesseract');
    if (process.send) {
        process.send({type: 'parser-ready'});
    }

    const ocr_engine = has_tesseract ? 'tesseract' : 'tesseract.js';
    log(root_uid, 'parser_start', `dir=${format_log_value(dir)} watch=${watch} detector=rembg model=${rembg_model()} ocr=${ocr_engine} qr=wechat,jsqr,zxing`);
    const state = await load_state(dir);
    const settling = new Map();

    // Inventory: report every image's status, queue the unprocessed ones.
    // Settle-check is skipped for files that already exist on start.
    const candidates = await list_candidates(dir);
    log(root_uid, 'inventory_begin', `images=${candidates.length}`);
    let queued = 0;
    for (const cand of candidates) {
        const known = state[cand.name];
        const name = format_log_value(cand.name);
        if (known && (known.size === cand.size) && (known.mtime === cand.mtime)) {
            if (known.status === 'failed') {
                // Retried only if the file changes.
                log(root_uid, 'inventory_failed', `name=${name} reason=${format_log_value(known.reason)}`);
            }
            else if (await fs_exists(fs_path_join(dir, known.target))) {
                log(root_uid, 'inventory_done', `name=${name} target=${format_log_value(known.target)}`);
            }
            else {
                log(root_uid, 'inventory_output_missing', `name=${name} target=${format_log_value(known.target)}`);
                delete state[cand.name];
                queued++;
            }
        }
        else {
            log(root_uid, 'inventory_queued', `name=${name}`);
            queued++;
        }
        settling.set(cand.name, cand);
    }
    log(root_uid, 'inventory_end', `queued=${queued}`);
    await scan(root_uid, dir, state, settling);

    if (!watch) {
        await shutdown_ocr();
        log(root_uid, 'parser_done');
        return;
    }

    log(root_uid, 'watch_begin', `interval=${format_seconds(poll_ms)}`);
    process.on('SIGINT', async function () {
        await shutdown_ocr();
        log(root_uid, 'watch_end_ok', 'signal=SIGINT');
        process.exit(0);
    });
    for (;;) {
        await sleep(poll_ms);
        await scan(root_uid, dir, state, settling);
    }
}

function sleep(ms)
{
    return new Promise(v => setTimeout(v, ms));
}

// Logs <stem>_begin, then <stem>_end_ok or <stem>_end_error with the elapsed time.
async function log_stage(group_uid, stem, details, fn)
{
    const start = performance.now();
    log(group_uid, `${stem}_begin`, details);
    try {
        const out = await fn();
        log(group_uid, `${stem}_end_ok`, format_seconds(performance.now() - start));
        return out;
    }
    catch (error) {
        log(group_uid, `${stem}_end_error`, `${format_seconds(performance.now() - start)} error=${format_log_value(error.message.split('\n')[0])}`);
        throw error;
    }
}

// Run a child process, resolving with its stdout as a Buffer. Child stderr is
// captured, kept out of the tool's log stream, and attached to the error on
// failure. opts.input is written to the child's stdin.
function command_run(cmd, args, opts = {})
{
    return new Promise(function (resolve, reject) {
        const child = execFile(cmd, args, {maxBuffer: 256*1024*1024, encoding: 'buffer'}, function (error, stdout, stderr) {
            if (error) {
                error.stderr = stderr ? stderr.toString() : '';
                reject(error);
            }
            else {
                resolve(stdout);
            }
        });
        // The child may exit before reading stdin.
        child.stdin.on('error', ignore);
        child.stdin.end(opts.input);
    });
}

function ignore()
{
}

function convert(args, opts)
{
    return command_run('convert', args, opts);
}

async function is_command_available(cmd)
{
    try {
        await command_run('which', [cmd]);
        return true;
    }
    catch {
        return false;
    }
}

// ---- receipt detection ----

function parse_pnm(data)
{
    if ((data[0] !== 0x50) || ((data[1] !== 0x35) && (data[1] !== 0x36))) {
        throw new Error('not a P5/P6 pnm');
    }
    const channels = (data[1] === 0x36) ? 3 : 1;
    const fields = [];
    let pos = 2;
    while (fields.length < 3) {
        while ((data[pos] === 0x20) || (data[pos] === 0x09) || (data[pos] === 0x0a) || (data[pos] === 0x0d)) {
            pos++;
        }
        if (data[pos] === 0x23) {
            while (data[pos] !== 0x0a) {
                pos++;
            }
            continue;
        }
        const start = pos;
        while ((data[pos] !== 0x20) && (data[pos] !== 0x09) && (data[pos] !== 0x0a) && (data[pos] !== 0x0d)) {
            pos++;
        }
        fields.push(Number(data.slice(start, pos).toString()));
    }
    pos++;
    return {w: fields[0], h: fields[1], px: data.slice(pos), channels};
}

function find_largest_component(mask, w, h)
{
    const seen = new Uint8Array(w*h);
    const queue = new Int32Array(w*h);
    let out = null;
    for (let start = 0; start < w*h; start++) {
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
                if ((j >= 0) && (j < w*h) && mask[j] && !seen[j]) {
                    seen[j] = 1;
                    queue[tail++] = j;
                }
            }
        }
        if ((out === null) || (comp.length > out.length)) {
            out = comp;
        }
    }
    return out;
}

// Receipt blob via rembg's segmentation mask, downscaled to analysis size.
// Returns null when rembg is unavailable or its mask finds nothing usable.
async function blob_from_rembg(group_uid, file, mask_path)
{
    // rembg reads the raw file; bail to the chroma path when EXIF would make
    // its coordinates disagree with the -auto-orient'ed warp space.
    const orientation = (await convert([file, '-format', '%[orientation]', 'info:'])).toString();
    if ((orientation !== 'Undefined') && (orientation !== 'TopLeft')) {
        return null;
    }
    // The mask has occasionally been unreadable right after rembg exits
    // (truncated write); a full second attempt covers that race.
    const model = rembg_model();
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            await log_stage(group_uid, 'rembg_mask', `model=${model} attempt=${attempt}`, () => command_run('rembg', ['i', '-m', model, '-om', file, mask_path]));
            const {w, h, px} = parse_pnm(await convert([mask_path, '-resize', '25%', 'pgm:-']));
            const mask = new Uint8Array(w*h);
            for (let i = 0; i < w*h; i++) {
                mask[i] = (px[i] > 127) ? 1 : 0;
            }
            const comp = find_largest_component(mask, w, h);
            if ((comp === null) || (comp.length < w*h/50)) {
                return null;
            }
            return {w, h, comp};
        }
        catch (error) {
            const reason = format_log_value(error.message.split('\n')[0]);
            if (attempt === 1) {
                log(group_uid, 'rembg_mask_retry', `error=${reason}`);
            }
            if (attempt === 2) {
                log(group_uid, 'rembg_mask_fallback', `detector=chroma error=${reason}`);
            }
        }
        finally {
            await fs_rmf(mask_path);
        }
    }
    return null;
}

// Receipt blob via the color heuristic: paper is near-neutral (low chroma)
// even in shadow; wood is orange with hi-lo >= ~29. Relax only when the
// strict mask finds no plausible blob.
async function blob_from_chroma(file)
{
    const {w, h, px} = parse_pnm(await convert([file, '-auto-orient', '-resize', '25%', 'ppm:-']));
    const thresholds = [[120, 24], [110, 32], [100, 40]];
    let best = null;
    for (const [lo_min, chroma_max] of thresholds) {
        const mask = new Uint8Array(w*h);
        for (let i = 0; i < w*h; i++) {
            const r = px[3*i];
            const g = px[3*i + 1];
            const b = px[3*i + 2];
            const lo = Math.min(r, g, b);
            const hi = Math.max(r, g, b);
            if ((lo > lo_min) && (hi - lo < chroma_max)) {
                mask[i] = 1;
            }
        }
        const comp = find_largest_component(mask, w, h);
        if ((comp !== null) && (comp.length >= w*h/10)) {
            return {w, h, comp};
        }
        if ((comp !== null) && ((best === null) || (comp.length > best.length))) {
            best = comp;
        }
    }
    if ((best === null) || (best.length < w*h/50)) {
        return null;
    }
    return {w, h, comp: best};
}

async function find_quad(group_uid, file, mask_path)
{
    const blob = (await blob_from_rembg(group_uid, file, mask_path)) || (await blob_from_chroma(file));
    if (blob === null) {
        throw new Error('receipt blob not found');
    }
    const {w, h, comp} = blob;

    let tl = null;
    let tr = null;
    let br = null;
    let bl = null;
    for (const i of comp) {
        const p = [i % w, Math.floor(i/w)];
        if ((tl === null) || (p[0] + p[1] < tl[0] + tl[1])) {
            tl = p;
        }
        if ((br === null) || (p[0] + p[1] > br[0] + br[1])) {
            br = p;
        }
        if ((tr === null) || (p[0] - p[1] > tr[0] - tr[1])) {
            tr = p;
        }
        if ((bl === null) || (p[0] - p[1] < bl[0] - bl[1])) {
            bl = p;
        }
    }

    const full = (await convert([file, '-auto-orient', '-format', '%w %h', 'info:'])).toString().split(' ').map(Number);
    const scale = full[0]/w;
    const scaled = [tl, tr, br, bl].map(v => [v[0]*scale, v[1]*scale]);

    // The mask boundary sits inside the true paper edge; push every corner
    // out by a few px along both adjacent edges so the crop never shaves text.
    const margin_px = 6;
    function direction_from(from, to) {
        const len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
        return [(to[0] - from[0])/len, (to[1] - from[1])/len];
    }
    const pushed = scaled.map(function (p, i) {
        const d1 = direction_from(scaled[(i + 1) % 4], p);
        const d2 = direction_from(scaled[(i + 3) % 4], p);
        return [p[0] + (d1[0] + d2[0])*margin_px, p[1] + (d1[1] + d2[1])*margin_px];
    });

    // Bottom corners detect short where the paper edge casts a shadow, and
    // BON FISCAL prints at the paper's cut edge — extend 1.5% along the sides.
    function extend(p, q) {
        return [q[0] + (q[0] - p[0])*0.015, q[1] + (q[1] - p[1])*0.015];
    }
    pushed[3] = extend(pushed[0], pushed[3]);
    pushed[2] = extend(pushed[1], pushed[2]);
    return pushed.map(v => [Math.round(v[0]), Math.round(v[1])]);
}

async function warp(file, quad, out_file)
{
    const [tl, tr, br, bl] = quad;
    function distance_of(a, b) {
        return Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    const w = Math.round(Math.max(distance_of(tl, tr), distance_of(bl, br)));
    const h = Math.round(Math.max(distance_of(tl, bl), distance_of(tr, br)));
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
function quarter_turns_from_axis(tl, tr)
{
    const angle = Math.atan2(tr.y - tl.y, tr.x - tl.x)*180/Math.PI;
    return ((Math.round(angle/90) % 4) + 4) % 4;
}

function decode_qr_buffer(buf, w, h)
{
    const code = jsQR(new Uint8ClampedArray(buf), w, h);
    if ((code !== null) && code.data.startsWith('http')) {
        const {topLeftFinderPattern, topRightFinderPattern} = code.location;
        return {url: code.data, rot: quarter_turns_from_axis(topLeftFinderPattern, topRightFinderPattern)};
    }

    const lum = new Int32Array(w*h);
    for (let i = 0; i < w*h; i++) {
        lum[i] = buf[i*4];
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
                return {url: text, rot: quarter_turns_from_axis(tl, tr)};
            }
        }
        catch {
            // next binarizer
        }
    }
    return null;
}

// The WeChat scanner reads the file itself and needs no variant sweep, so it
// runs first: on this corpus it alone decodes most receipts, and a hit here
// skips the nine convert() passes below.
async function decode_qr_wechat(src)
{
    try {
        const hit = JSON.parse((await command_run('python3', [wechat_helper, src])).toString());
        return {url: hit.url, rot: quarter_turns_from_axis(hit.tl, hit.tr)};
    }
    catch {
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
            const eff = Math.min(scale, qr_max_long_side/Math.max(w0, h0));
            const w = Math.round(w0*eff);
            const h = Math.round(h0*eff);
            try {
                const raw = await convert([src, '-auto-orient', '-colorspace', 'Gray', '-resize', `${w}x${h}!`, ...pre, '-depth', '8', 'rgba:-']);
                const decoded = decode_qr_buffer(raw, w, h);
                if (decoded !== null) {
                    return decoded;
                }
            }
            catch {
                // try next variant
            }
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
            if (Array.isArray(receipt) && (receipt.length > 0)) {
                return receipt;
            }
        }
        catch {
            // not the receipt component
        }
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

async function fetch_with_retry(group_uid, url, opts)
{
    for (let attempt = 1; ; attempt++) {
        try {
            return await fetch(url, opts);
        }
        catch (error) {
            if (attempt === 3) {
                throw error;
            }
            log(group_uid, 'mev_fetch_retry', `attempt=${attempt} delay=${format_seconds(attempt*2000)} error=${format_log_value(error.message)}`);
            await sleep(attempt*2000);
        }
    }
}

async function fetch_receipt(group_uid, qr_url)
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
    const resp = await fetch_with_retry(group_uid, qr_url, {headers: {'User-Agent': user_agent, 'Accept-Language': 'ro,en;q=0.7'}});
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

async function get_ocr_worker(group_uid)
{
    if (ocr_worker === null) {
        // The first run downloads language data.
        ocr_worker = await log_stage(group_uid, 'ocr_worker_load', '', () => createWorker('eng', 1, {cachePath: __dirname}));
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
        const alias = merchant_aliases.find(v => upper.includes(v[0]));
        if (alias) {
            out.merchant = alias[0];
            break;
        }
    }
    if (out.merchant === null) {
        out.merchant = lines.find(v => /[A-Za-z]{3}/.test(v)) || null;
    }

    // OCR often splits decimals ("429. 49") — allow one space after the separator.
    const amount_pattern = String.raw`(\d+[.,]\s?\d{2})`;
    function amount_from_text(s) {
        return Number(s.replace(/\s/g, '').replace(',', '.'));
    }
    let m;
    if ((m = text.match(new RegExp(String.raw`TOTAL(?:\s+LEI)?\s*[.:]*\s*${amount_pattern}`, 'i')))) {
        out.total = amount_from_text(m[1]);
    }
    const numerar = (m = text.match(new RegExp(String.raw`NUMERAR(?:\s+LEI)?\s*[.:]*\s*${amount_pattern}`, 'i'))) ? amount_from_text(m[1]) : null;
    const rest = (m = text.match(new RegExp(String.raw`REST(?::?\s*NUMERAR)?(?:\s+LEI)?\s*[.:]*\s*${amount_pattern}`, 'i'))) ? amount_from_text(m[1]) : null;
    if ((out.total !== null) && (numerar !== null) && (rest !== null)) {
        out.total_confirmed = Math.abs(numerar - rest - out.total) < 0.005;
    }

    function is_plausible_date(d, mo) {
        return (Number(d) >= 1) && (Number(d) <= 31) && (Number(mo) >= 1) && (Number(mo) <= 12);
    }
    if ((m = text.match(/\b(\d{2})-(\d{2})-(20\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\b/)) && is_plausible_date(m[1], m[2])) {
        out.date = `${m[3]}-${m[2]}-${m[1]}`;
        out.time = m[4];
    }
    else {
        const dm = text.match(/\b(\d{2})-(\d{2})-(20\d{2})\b/);
        const tm = text.match(/\b(\d{2}:\d{2}:\d{2})\b/);
        if (dm && tm && is_plausible_date(dm[1], dm[2])) {
            out.date = `${dm[3]}-${dm[2]}-${dm[1]}`;
            out.time = tm[1];
        }
    }
    return out;
}

async function recognize_text(group_uid, input)
{
    if (has_tesseract) {
        const from_file = (typeof input === 'string');
        const text = await command_run('tesseract', [from_file ? input : '-', 'stdout', '-l', 'ron+eng', '--psm', '4'], from_file ? {} : {input});
        return text.toString();
    }
    const worker = await get_ocr_worker(group_uid);
    const {data} = await worker.recognize(input);
    return data.text;
}

async function ocr_receipt(group_uid, tmp, reason, orientations)
{
    return log_stage(group_uid, 'ocr', `reason=${format_log_value(reason)}`, () => ocr_receipt_attempts(group_uid, tmp, reason, orientations));
}

async function ocr_receipt_attempts(group_uid, tmp, reason, orientations)
{
    const attempts = [[], ['-colorspace', 'Gray', '-resize', '250%', '-normalize']];
    for (const orient of orientations) {
        const rotate = (orient === 0) ? [] : ['-rotate', String(orient)];
        for (const pre of attempts) {
            const args = [...rotate, ...pre];
            const input = (args.length === 0) ? tmp : await convert([tmp, ...args, 'png:-']);
            const text = await recognize_text(group_uid, input);
            const ocr = parse_ocr_text(text);
            if (!ocr.merchant || (ocr.total === null) || !ocr.date || !ocr.time) {
                continue;
            }
            if (!ocr.total_confirmed) {
                // NUMERAR-REST was unreadable.
                log(group_uid, 'ocr_total_unconfirmed', `total=${ocr.total}`);
            }
            ocr.lines = text.split('\n').map(v => v.trim()).filter(Boolean);
            return {source: 'ocr', reason, rotate: orient, ocr};
        }
    }
    return null;
}

// ---- naming ----

function merchant_slug_from_name(name)
{
    const upper = name.toUpperCase();
    if (upper.includes('FARMACI')) {
        return 'farmacy';
    }
    for (const [needle, slug] of merchant_aliases) {
        if (upper.includes(needle)) {
            return slug;
        }
    }
    const stripped = upper.replace(/\b(I\.?C\.?S\.?|S\.?R\.?L\.?|S\.?A\.?|Î\.?M\.?)\b/g, ' ');
    const m = stripped.match(/[A-Z0-9]+/);
    return (m === null) ? 'unknown' : m[0].toLowerCase();
}

function target_base_from_facts(facts)
{
    const {merchant, total, date, time} = facts;
    if (!merchant || (total === null) || !date || !time) {
        return null;
    }
    const ymd = date.replace(/-/g, '');
    const hm = time.slice(0, 5).replace(':', '');
    return `${ymd}_${hm}_${merchant_slug_from_name(merchant)}_${Math.round(total)}`;
}

// ---- per-file processing ----

async function image_area_of(file)
{
    const [w, h] = (await convert([file, '-format', '%w %h', 'info:'])).toString().split(' ').map(Number);
    return w*h;
}

// One group per photo: photo_begin, the stages, then photo_end_ok (done,
// duplicate) or photo_end_error (failed, or retried after the cooldown).
async function photo_process(root_uid, dir, name)
{
    const group_uid = log_group_spawn(root_uid);
    const start = performance.now();
    log(group_uid, 'photo_begin', `name=${format_log_value(name)}`);
    const out = await photo_process_stages(group_uid, dir, name);
    const elapsed = format_seconds(performance.now() - start);
    if ((out !== null) && (out.status !== 'failed')) {
        log(group_uid, 'photo_end_ok', `${elapsed} status=${out.status} target=${format_log_value(out.target)}`);
        return out;
    }
    const outcome = (out === null) ? `retry_in=${format_seconds(retry_cooldown_ms)}` : `status=failed reason=${format_log_value(out.reason)}`;
    log(group_uid, 'photo_end_error', `${elapsed} ${outcome}`);
    return out;
}

async function photo_process_stages(group_uid, dir, name)
{
    const file = fs_path_join(dir, name);
    const tmp = fs_path_join(dir, tmp_file);

    let quad;
    let size;
    try {
        quad = await log_stage(group_uid, 'receipt_detect', '', () => find_quad(group_uid, file, fs_path_join(dir, mask_file)));
        size = await log_stage(group_uid, 'perspective_warp', '', () => warp(file, quad, tmp));
    }
    catch (error) {
        return {status: 'failed', reason: error.message};
    }
    log(group_uid, 'receipt_straightened', `size=${size.w}x${size.h}`);

    let receipt = null;
    let transient = false;
    const decoded = await log_stage(group_uid, 'qr_decode', '', () => decode_qr([tmp, file]));
    if (decoded === null) {
        // No QR to orient by: a landscape result must be sideways; portrait may
        // still be upside down — let OCR pick the orientation that parses.
        const orientations = (size.w > size.h) ? [90, 270] : [0, 180];
        receipt = await ocr_receipt(group_uid, tmp, 'QR undecodable', orientations);
    }
    else {
        if (decoded.rot !== 0) {
            const upright = [0, 1, 2, 3].map(v => quad[(v + decoded.rot) % 4]);
            size = await warp(file, upright, tmp);
            log(group_uid, 'receipt_rotated_by_qr', `angle=${decoded.rot*90} size=${size.w}x${size.h}`);
        }
        log(group_uid, 'qr_decoded', `url=${format_log_value(decoded.url)}`);
        try {
            const fetched = await log_stage(group_uid, 'mev_fetch', '', () => fetch_receipt(group_uid, decoded.url));
            if (fetched.mev) {
                receipt = {source: 'mev', qr_url: fetched.qr_url, url_data: fetched.url_data, http_status: fetched.http_status, mev: fetched.mev};
            }
            else {
                receipt = await ocr_receipt(group_uid, tmp, `MEV page had no receipt data (http ${fetched.http_status})`, [0]);
                transient = true;
            }
        }
        catch (error) {
            receipt = await ocr_receipt(group_uid, tmp, `MEV fetch failed (${error.message})`, [0]);
            transient = true;
        }
    }
    if (receipt === null) {
        await fs_rmf(tmp);
        if (transient) {
            // MEV unreachable and OCR incomplete.
            retry_cooldown.set(name, Date.now() + retry_cooldown_ms);
            return null;
        }
        log(group_uid, 'photo_unreadable', 'hint="re-shoot closer/sharper"');
        return {status: 'failed', reason: 'qr/mev/ocr all failed'};
    }

    if (receipt.rotate) {
        await convert([tmp, '-rotate', String(receipt.rotate), '-quality', '92', tmp]);
        if (receipt.rotate !== 180) {
            size = {w: size.h, h: size.w};
        }
        log(group_uid, 'receipt_rotated_by_ocr', `angle=${receipt.rotate}`);
    }
    delete receipt.rotate;

    const facts = receipt.mev || receipt.ocr;
    log(group_uid, 'receipt_facts', `source=${receipt.source} merchant=${format_log_value(facts.merchant)} date=${format_log_value(facts.date)} time=${format_log_value(facts.time)} total=${format_log_value(facts.total)}`);

    const base = target_base_from_facts(facts);
    if (base === null) {
        await fs_rmf(tmp);
        return {status: 'failed', reason: 'incomplete data'};
    }

    receipt.image = `${base}.jpg`;
    const jpg = fs_path_join(dir, `${base}.jpg`);
    const json_file = fs_path_join(dir, `${base}.json`);
    const new_area = size.w*size.h;
    if (await fs_exists(jpg)) {
        const old_area = await image_area_of(jpg);
        if (new_area <= old_area) {
            await fs_rmf(tmp);
            log(group_uid, 'photo_duplicate_kept', `target=${format_log_value(`${base}.jpg`)} old_area=${old_area} new_area=${new_area}`);
            let old_source = null;
            try {
                old_source = (await fs_read_json(json_file)).source || 'mev';
            }
            catch {
                // missing or unreadable sidecar
            }
            if ((old_source === null) || ((old_source === 'ocr') && (receipt.source === 'mev'))) {
                await fs_write_json(json_file, receipt);
                log(group_uid, 'sidecar_written', `target=${format_log_value(`${base}.json`)} was=${(old_source === null) ? 'missing' : 'ocr'}`);
            }
            return {status: 'duplicate', target: `${base}.jpg`};
        }
        log(group_uid, 'photo_duplicate_replaced', `target=${format_log_value(`${base}.jpg`)} old_area=${old_area} new_area=${new_area}`);
    }

    await fs_rename(tmp, jpg);
    await fs_write_json(json_file, receipt);
    return {status: 'done', target: `${base}.jpg`, area: new_area};
}

// ---- directory scanning / watching ----

async function load_state(dir)
{
    try {
        return await fs_read_json(fs_path_join(dir, state_file));
    }
    catch {
        return {};
    }
}

async function save_state(dir, state)
{
    await fs_write_json(fs_path_join(dir, state_file), state);
}

async function list_candidates(dir)
{
    const out = [];
    for (const name of (await fs_readdir(dir)).sort()) {
        if (name.startsWith('.') || !image_re.test(name) || output_re.test(name)) {
            continue;
        }
        try {
            const stat = await fs_stat(fs_path_join(dir, name));
            if (stat.isFile()) {
                out.push({name, size: stat.size, mtime: stat.mtimeMs});
            }
        }
        catch {
            // vanished between readdir and stat
        }
    }
    return out;
}

async function scan(root_uid, dir, state, settling)
{
    let processed = 0;
    for (const cand of await list_candidates(dir)) {
        const known = state[cand.name];
        if (known && (known.size === cand.size) && (known.mtime === cand.mtime)) {
            // Self-heal: a deleted output means the work needs redoing.
            if ((known.status === 'failed') || (await fs_exists(fs_path_join(dir, known.target)))) {
                continue;
            }
            log(root_uid, 'scan_output_missing', `name=${format_log_value(cand.name)} target=${format_log_value(known.target)}`);
            delete state[cand.name];
        }
        if ((retry_cooldown.get(cand.name) || 0) > Date.now()) {
            continue;
        }

        // Only touch a file once its size/mtime survived one full poll interval —
        // it may still be uploading.
        const pending = settling.get(cand.name);
        if (!pending || (pending.size !== cand.size) || (pending.mtime !== cand.mtime)) {
            if (!pending && !retry_cooldown.has(cand.name)) {
                log(root_uid, 'scan_new_file', `name=${format_log_value(cand.name)}`);
            }
            settling.set(cand.name, cand);
            continue;
        }
        settling.delete(cand.name);

        const result = await photo_process(root_uid, dir, cand.name);
        if (result !== null) {
            state[cand.name] = {size: cand.size, mtime: cand.mtime, ...result};
            await save_state(dir, state);
        }
        processed++;
    }
    return processed;
}
