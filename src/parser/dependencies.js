const {execFile} = require('child_process');
const path = require('path');

const REMBG_MODEL = process.env.REMBG_MODEL || 'u2net';

function run(cmd, args, input, timeout = 15000)
{
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, {encoding: 'buffer', timeout, maxBuffer: 8 * 1024 * 1024},
            (err, stdout, stderr) => {
                if (err) {
                    const detail = stderr.toString().trim().split('\n').slice(-3).join('\n');
                    reject(new Error(`${err.killed ? 'check timed out' : err.message}${detail ? `\n${detail}` : ''}`));
                } else {
                    resolve(stdout);
                }
            });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

async function check_dependencies(log = console.log)
{
    log('checking native QR scanners...');
    try {
        await run('python3', [path.join(__dirname, 'qr_wechat.py'), '--check']);
    } catch (err) {
        throw new Error(`Native QR scanners are required and failed their decode check.\n`
            + `Install opencv-contrib-python-headless and zxing-cpp in the python3 environment.\n${err.message}`);
    }

    log(`checking rembg (${REMBG_MODEL}) with a test image; first use may download the model...`);
    try {
        // Exercise the actual CLI/backend/model, not merely command presence.
        const pixels = Buffer.alloc(32 * 64 * 3);
        for (let y = 8; y < 56; y++) {
            for (let x = 8; x < 24; x++) {
                pixels.fill(255, (y * 32 + x) * 3, (y * 32 + x + 1) * 3);
            }
        }
        const input = Buffer.concat([Buffer.from('P6\n32 64\n255\n'), pixels]);
        const mask = await run('rembg', ['i', '-m', REMBG_MODEL, '-om', '-', '-'], input, 120000);
        const size = await run('convert', ['-', '-format', '%w %h', 'info:'], mask);
        if (size.toString() !== '32 64') {
            throw new Error('rembg did not return a readable mask with the expected dimensions');
        }
    } catch (err) {
        throw new Error(`rembg (${REMBG_MODEL}) is required and failed its model check.\n`
            + `Install rembg[cpu,cli] and ImageMagick; verify the model can load.\n${err.message}`);
    }
    log('required parser dependencies are ready');
}

module.exports = {check_dependencies, REMBG_MODEL};
