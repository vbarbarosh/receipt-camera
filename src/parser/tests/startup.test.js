const assert = require('node:assert/strict');
const cli = require('@vbarbarosh/node-helpers/src/cli');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {spawnSync} = require('node:child_process');

const repo = path.resolve(__dirname, '../../..');
const parser_entry = path.join(repo, 'src/parser/index.js');
const launcher_entry = path.join(repo, 'src/run.js');
const http_entry = path.join(repo, 'src/http/index.js');
const entries = [parser_entry, launcher_entry, http_entry];
const original_path = process.env.PATH;

cli(main);

function main()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-startup-test-'));
    const env = {PATH: `${root}:${original_path}`};
    let checks = 0;
    try {
        fake_write(root, 'python3', 'echo "missing scanner" >&2; exit 1');
        for (const entry of entries) {
            refusal_check(root, entry, env, /Native QR scanners are required/);
            checks++;
        }
        fake_write(root, 'python3', 'exit 0');
        fake_write(root, 'rembg', 'echo "broken backend" >&2; exit 1');
        for (const entry of entries) {
            refusal_check(root, entry, env, /rembg \(u2net\) is required/);
            checks++;
        }
        fs.unlinkSync(path.join(root, 'rembg'));
        refusal_check(root, launcher_entry, {PATH: root}, /rembg \(u2net\) is required/);
        checks++;
        fake_write(root, 'rembg', 'echo "not a mask"');
        refusal_check(root, launcher_entry, env, /rembg \(u2net\) is required/);
        checks++;
        console.log(`Passed ${checks} startup refusal checks`);
    }
    finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
}

function fake_write(root, name, body)
{
    fs.writeFileSync(path.join(root, name), `#!/bin/sh\n${body}\n`, {mode: 0o755});
}

function refusal_check(root, entry, env, expected)
{
    const args = (entry === parser_entry) ? [entry, '--check-dependencies'] : [entry];
    const result = spawnSync(process.execPath, args, {cwd: root, env: {...process.env, PORT: '0', ...env}, timeout: 15000, encoding: 'utf8'});
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    assert.match(output, expected);
    assert.doesNotMatch(output, /\[server_listen\]|\[server_lan_url\]/);
}
