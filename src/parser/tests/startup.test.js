const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const parserEntry = path.join(repo, 'src/parser/index.js');
const launcherEntry = path.join(repo, 'src/run.js');
const httpEntry = path.join(repo, 'src/http/index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-startup-test-'));
const originalPath = process.env.PATH;
let checks = 0;
function fake(name, body) { fs.writeFileSync(path.join(root, name), '#!/bin/sh\n' + body + '\n', {mode: 0o755}); }
function check(entry, env, expected) {
    const r = spawnSync(process.execPath, [entry, ...(entry.endsWith('parser/index.js') ? ['--check-dependencies'] : [])], {
        cwd: root, env: {...process.env, PORT: '0', ...env}, timeout: 15000, encoding: 'utf8'
    });
    const output = r.stdout + r.stderr;
    assert.equal(r.status, 1, output);
    assert.match(output, expected);
    assert.doesNotMatch(output, /saving to|open on your phone/);
    checks++;
}
try {
    fake('python3', 'echo "missing scanner" >&2; exit 1');
    for (const entry of [parserEntry,launcherEntry,httpEntry]) {
        check(entry, {PATH: root + ':' + originalPath}, /Native QR scanners are required/);
    }
    fake('python3', 'exit 0');
    fake('rembg', 'echo "broken backend" >&2; exit 1');
    for (const entry of [parserEntry,launcherEntry,httpEntry]) {
        check(entry, {PATH: root + ':' + originalPath}, /rembg \(u2net\) is required/);
    }
    fs.unlinkSync(path.join(root,'rembg'));
    check(launcherEntry, {PATH: root}, /rembg \(u2net\) is required/);
    fake('rembg', 'echo "not a mask"');
    check(launcherEntry, {PATH: root + ':' + originalPath}, /rembg \(u2net\) is required/);
    console.log(`Passed ${checks} startup refusal checks`);
} finally { fs.rmSync(root, {recursive:true, force:true}); }
