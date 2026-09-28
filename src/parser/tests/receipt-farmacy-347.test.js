// Runs the parser on fixtures/receipt-farmacy-347.jpg and expects the fiscal QR
// URL, which a phone's native reader decodes but the parser once did not.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const parserEntry = path.join(repo, 'src/parser/index.js');
const fixture = path.join(repo, 'src/parser/fixtures/receipt-farmacy-347.jpg');
const expected = 'https://sift-mev.sfs.md/receipt/6BCD96E1530A1AA29442CE702B9B89E2';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-qr-test-'));
fs.copyFileSync(fixture, path.join(root, 'receipt.jpg'));

const child = spawn(process.execPath, [parserEntry, root], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
let output = '';
const timer = setTimeout(() => stop(null, 'timed out'), 900000);
child.stdout.on('data', function (data) {
    process.stdout.write(data);
    output += data;
    const m = output.match(/QR → (\S+)/);
    if (m !== null) {
        stop(m[1], 'decoded');
    }
    else if (output.includes('falling back to OCR')) {
        stop(null, 'QR undecodable');
    }
});
child.stderr.on('data', data => process.stderr.write(data));
let url = null;
let reason = 'parser exited';
function stop(found, why)
{
    url = found;
    reason = why;
    child.kill();
}
child.on('exit', function () {
    clearTimeout(timer);
    fs.rmSync(root, {recursive: true, force: true});
    assert.equal(url, expected, reason);
    console.log(`Passed: QR → ${url}`);
});
