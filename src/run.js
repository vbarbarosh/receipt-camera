// Start the upload server only after the parser validates its dependencies.
const {fork} = require('child_process');
const path = require('path');

const children = new Set();
let stopping = false;
let exit_code = 0;
let server_started = false;

function stop(code)
{
    if (stopping) return;
    stopping = true;
    exit_code = code;
    for (const child of children) child.kill('SIGTERM');
    if (children.size === 0) process.exit(exit_code);
    setTimeout(() => {
        for (const child of children) child.kill('SIGKILL');
    }, 3000).unref();
}

function start(file, args = [])
{
    const child = fork(path.join(__dirname, file), args, {stdio: ['inherit', 'inherit', 'inherit', 'ipc']});
    children.add(child);
    child.on('error', err => {
        console.error(err.message);
        stop(1);
    });
    child.on('exit', (code, signal) => {
        children.delete(child);
        if (!stopping) stop(code === 0 && !signal ? 0 : 1);
        if (children.size === 0) process.exit(exit_code);
    });
    return child;
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
const parser = start('parser/index.js', ['--watch']);
parser.on('message', message => {
    if (!stopping && !server_started && message && message.type === 'parser-ready') {
        server_started = true;
        start('http/index.js');
    }
});
