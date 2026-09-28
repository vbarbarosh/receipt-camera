const format_seconds = require('../helpers/format_seconds');
const fs_path_join = require('@vbarbarosh/node-helpers/src/fs_path_join');
const log = require('../helpers/log');
const rembg_model = require('./rembg_model');

const {execFile} = require('child_process');

async function dependencies_check(group_uid)
{
    const model = rembg_model();

    const qr_start = performance.now();
    log(group_uid, 'dependencies_qr_check_begin');
    try {
        await command_run('python3', [fs_path_join(__dirname, 'qr_wechat.py'), '--check']);
    }
    catch (error) {
        log(group_uid, 'dependencies_qr_check_end_error', format_seconds(performance.now() - qr_start));
        throw new Error('Native QR scanners are required and failed their decode check.\n'
            + `Install opencv-contrib-python-headless and zxing-cpp in the python3 environment.\n${error.message}`);
    }
    log(group_uid, 'dependencies_qr_check_end_ok', format_seconds(performance.now() - qr_start));

    // First use may download the model.
    const rembg_start = performance.now();
    log(group_uid, 'dependencies_rembg_check_begin', `model=${model}`);
    try {
        // Exercise the actual CLI/backend/model, not merely command presence.
        const pixels = Buffer.alloc(32*64*3);
        for (let y = 8; y < 56; y++) {
            for (let x = 8; x < 24; x++) {
                pixels.fill(255, (y*32 + x)*3, (y*32 + x + 1)*3);
            }
        }
        const input = Buffer.concat([Buffer.from('P6\n32 64\n255\n'), pixels]);
        const mask = await command_run('rembg', ['i', '-m', model, '-om', '-', '-'], input, 120000);
        const size = await command_run('convert', ['-', '-format', '%w %h', 'info:'], mask);
        if (size.toString() !== '32 64') {
            throw new Error('rembg did not return a readable mask with the expected dimensions');
        }
    }
    catch (error) {
        log(group_uid, 'dependencies_rembg_check_end_error', format_seconds(performance.now() - rembg_start));
        throw new Error(`rembg (${model}) is required and failed its model check.\n`
            + `Install rembg[cpu,cli] and ImageMagick; verify the model can load.\n${error.message}`);
    }
    log(group_uid, 'dependencies_rembg_check_end_ok', format_seconds(performance.now() - rembg_start));
}

function command_run(cmd, args, input, timeout = 15000)
{
    return new Promise(function (resolve, reject) {
        const child = execFile(cmd, args, {encoding: 'buffer', timeout, maxBuffer: 8*1024*1024}, function (error, stdout, stderr) {
            if (error) {
                const detail = stderr.toString().trim().split('\n').slice(-3).join('\n');
                const reason = error.killed ? 'check timed out' : error.message;
                reject(new Error(detail ? `${reason}\n${detail}` : reason));
            }
            else {
                resolve(stdout);
            }
        });
        child.stdin.on('error', ignore);
        child.stdin.end(input);
    });
}

function ignore()
{
}

module.exports = dependencies_check;
