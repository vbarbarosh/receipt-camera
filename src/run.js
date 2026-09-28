// Start the upload server only after the parser validates its dependencies.
const cli = require('@vbarbarosh/node-helpers/src/cli');
const format_log_value = require('./helpers/format_log_value');
const fs_path_join = require('@vbarbarosh/node-helpers/src/fs_path_join');
const log = require('./helpers/log');
const log_group_spawn = require('./helpers/log_group_spawn');

const {fork} = require('child_process');

const children = new Set();
let group_uid = null;
let stopping = false;
let exit_code = 0;
let server_started = false;

cli(main);

function main()
{
    group_uid = log_group_spawn();
    process.on('SIGINT', () => stop(0));
    process.on('SIGTERM', () => stop(0));
    const parser = start('parser/index.js', ['--watch']);
    parser.on('message', function (message) {
        if (!stopping && !server_started && message && (message.type === 'parser-ready')) {
            server_started = true;
            start('http/index.js');
        }
    });
}

function stop(code)
{
    if (stopping) {
        return;
    }
    stopping = true;
    exit_code = code;
    for (const child of children) {
        child.kill('SIGTERM');
    }
    if (children.size === 0) {
        process.exit(exit_code);
    }
    setTimeout(kill_children, 3000).unref();
}

function kill_children()
{
    for (const child of children) {
        child.kill('SIGKILL');
    }
}

function start(file, args = [])
{
    const child = fork(fs_path_join(__dirname, file), args, {stdio: ['inherit', 'inherit', 'inherit', 'ipc']});
    children.add(child);
    child.on('error', function (error) {
        log(group_uid, 'child_error', `file=${file} error=${format_log_value(error.message)}`);
        stop(1);
    });
    child.on('exit', function (code, signal) {
        children.delete(child);
        if (!stopping) {
            stop(((code === 0) && !signal) ? 0 : 1);
        }
        if (children.size === 0) {
            process.exit(exit_code);
        }
    });
    return child;
}
