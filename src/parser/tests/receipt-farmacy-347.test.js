// Runs the parser on fixtures/receipt-farmacy-347.jpg and expects the fiscal QR
// URL, which a phone's native reader decodes but the parser once did not.
const assert = require('node:assert/strict');
const cli = require('@vbarbarosh/node-helpers/src/cli');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {spawn} = require('node:child_process');

const repo = path.resolve(__dirname, '../../..');
const parser_entry = path.join(repo, 'src/parser/index.js');
const fixture = path.join(repo, 'src/parser/fixtures/receipt-farmacy-347.jpg');
const expected = 'https://sift-mev.sfs.md/receipt/6BCD96E1530A1AA29442CE702B9B89E2';

cli(main);

async function main()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-qr-test-'));
    fs.copyFileSync(fixture, path.join(root, 'receipt.jpg'));
    try {
        const {url, reason} = await parser_watch(root);
        assert.equal(url, expected, reason);
        console.log(`Passed: QR → ${url}`);
    }
    finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
}

// Resolves with the decoded URL as soon as the parser logs it, or with null
// and the reason once the parser falls back to OCR, times out or exits.
function parser_watch(root)
{
    return new Promise(function (resolve) {
        const child = spawn(process.execPath, [parser_entry, root], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
        let output = '';
        let url = null;
        let reason = 'parser exited';
        const timer = setTimeout(() => stop(null, 'timed out'), 900000);
        function stop(found, why) {
            url = found;
            reason = why;
            child.kill();
        }
        child.stdout.on('data', function (data) {
            process.stdout.write(data);
            output += data;
            const m = output.match(/\[qr_decoded\] url=(\S+)/);
            if (m !== null) {
                stop(m[1], 'decoded');
            }
            else if (output.includes('[ocr_begin]')) {
                stop(null, 'QR undecodable');
            }
        });
        child.stderr.on('data', v => process.stderr.write(v));
        child.on('exit', function () {
            clearTimeout(timer);
            resolve({url, reason});
        });
    });
}
