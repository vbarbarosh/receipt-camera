const cli = require('@vbarbarosh/node-helpers/src/cli');
const dependencies_check = require('../parser/dependencies_check');
const format_log_value = require('../helpers/format_log_value');
const fs_append_utf8 = require('@vbarbarosh/node-helpers/src/fs_append_utf8');
const fs_exists = require('@vbarbarosh/node-helpers/src/fs_exists');
const fs_mkdirp = require('@vbarbarosh/node-helpers/src/fs_mkdirp');
const fs_path_basename = require('@vbarbarosh/node-helpers/src/fs_path_basename');
const fs_path_extname = require('@vbarbarosh/node-helpers/src/fs_path_extname');
const fs_path_join = require('@vbarbarosh/node-helpers/src/fs_path_join');
const fs_path_resolve = require('@vbarbarosh/node-helpers/src/fs_path_resolve');
const fs_read_buffer = require('@vbarbarosh/node-helpers/src/fs_read_buffer');
const fs_write = require('@vbarbarosh/node-helpers/src/fs_write');
const http = require('http');
const log = require('../helpers/log');
const log_group_spawn = require('../helpers/log_group_spawn');
const os = require('os');
const path = require('path');

const public_dir = fs_path_join(__dirname, 'public');
const receipts_dir = (process.argv[2] === undefined) ? process.cwd() : fs_path_resolve(process.argv[2]);
const port = Number(process.env.PORT ?? 8080);
const max_upload_bytes = 30*1024*1024;

const mime_by_ext = {
    '.apk': 'application/vnd.android.package-archive',
    '.css': 'text/css',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.ogg': 'audio/ogg',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.webmanifest': 'application/manifest+json',
};

const ext_by_mime = {
    'image/heic': '.heic',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
};

let group_uid = null;

cli(main);

async function main()
{
    group_uid = log_group_spawn();

    // The combined launcher already waited for the parser's preflight.
    if (!process.send) {
        await dependencies_check(group_uid);
    }
    await fs_mkdirp(receipts_dir);

    const server = http.createServer(function (req, res) {
        if ((req.method === 'POST') && (req.url === '/upload')) {
            upload_post(req, res);
            return;
        }
        if ((req.method === 'POST') && (req.url === '/client-log')) {
            client_log_post(req, res);
            return;
        }
        static_get(req, res);
    });

    server.listen(port, '0.0.0.0', function () {
        log(group_uid, 'server_listen', `port=${port} dir=${format_log_value(receipts_dir)}`);
        // Open on the phone, on the same wifi.
        for (const url of list_lan_urls()) {
            log(group_uid, 'server_lan_url', url);
        }
    });
}

// POST /upload (body, header:content-type)
function upload_post(req, res)
{
    const chunks = [];
    let received_bytes = 0;

    req.on('data', function (chunk) {
        received_bytes += chunk.length;
        if (received_bytes > max_upload_bytes) {
            res.writeHead(413, {'content-type': 'application/json'});
            res.end(JSON.stringify({error: 'too large'}));
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });

    req.on('end', async function () {
        if (res.writableEnded) {
            return;
        }
        if (received_bytes === 0) {
            res.writeHead(400, {'content-type': 'application/json'});
            res.end(JSON.stringify({error: 'empty body'}));
            return;
        }
        const ext = ext_by_mime[req.headers['content-type']] ?? '.jpg';
        const file_path = await find_receipt_path(ext);
        await fs_write(file_path, Buffer.concat(chunks));
        const kb = Math.round(received_bytes/1024);
        log(group_uid, 'upload_saved', `file=${format_log_value(fs_path_basename(file_path))} kb=${kb}`);
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({saved: fs_path_basename(file_path), kb}));
    });
}

// POST /client-log (body)
// A phone event, echoed to the console and appended to phone.log.
function client_log_post(req, res)
{
    const chunks = [];
    req.on('data', v => chunks.push(v));
    req.on('end', async function () {
        const details = format_phone_report(Buffer.concat(chunks).toString());
        log(group_uid, 'phone_report', details);
        await fs_append_utf8(fs_path_join(receipts_dir, 'phone.log'), `[${new Date().toISOString()}][${group_uid}][phone_report] ${details}\n`);
        res.writeHead(204);
        res.end();
    });
}

// GET /<path>
async function static_get(req, res)
{
    const url_path = req.url.split('?')[0];
    const relative = (url_path === '/') ? 'index.html' : url_path.slice(1);
    const file_path = fs_path_join(public_dir, relative);

    if (!file_path.startsWith(public_dir + path.sep) || !(await fs_exists(file_path))) {
        res.writeHead(404, {'content-type': 'text/plain'});
        res.end('not found');
        return;
    }

    res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': mime_by_ext[fs_path_extname(file_path)] ?? 'application/octet-stream',
    });
    res.end(await fs_read_buffer(file_path));
}

function format_phone_report(body)
{
    let report;
    try {
        report = JSON.parse(body);
    }
    catch {
        return `invalid=${format_log_value(body.slice(0, 200))}`;
    }
    return `version=${format_log_value(report.version)} event=${format_log_value(report.event)} detail=${format_log_value(report.detail)}`;
}

async function find_receipt_path(ext)
{
    const now = new Date();
    const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const time = `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
    const base = `receipt_${date}_${time}`;

    let out = fs_path_join(receipts_dir, `${base}${ext}`);
    let counter = 2;
    while (await fs_exists(out)) {
        out = fs_path_join(receipts_dir, `${base}_${counter}${ext}`);
        counter += 1;
    }
    return out;
}

function pad2(value)
{
    return String(value).padStart(2, '0');
}

function list_lan_urls()
{
    const out = [];
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses) {
            if ((address.family === 'IPv4') && !address.internal) {
                out.push(`http://${address.address}:${port}/`);
            }
        }
    }
    return out;
}
