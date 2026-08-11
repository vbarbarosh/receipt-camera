const version = 15;

const file_input = document.getElementById('file_input');
const next = document.getElementById('next');
const next_count = document.getElementById('next_count');
const status = document.getElementById('status');
const theme_toggle = document.getElementById('theme_toggle');
const toast = document.getElementById('toast');

let audio_context = null;
let saved_count = 0;
let shutter_buffer = null;
let toast_timer = null;

main();

function main()
{
    document.getElementById('version').textContent = `v${version}`;

    // theme: OS default, persisted override, resolved attribute always set
    const stored_theme = localStorage.getItem('theme');
    const os_theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = stored_theme === null ? os_theme : stored_theme;

    theme_toggle.addEventListener('click', function () {
        const next_theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next_theme;
        localStorage.setItem('theme', next_theme);
    });

    // the label tap is the user gesture that unlocks audio for the later save sound
    file_input.addEventListener('click', function () {
        if (audio_context === null) {
            audio_context = new AudioContext();
        }
        if (audio_context.state === 'suspended') {
            audio_context.resume();
        }
    });

    file_input.addEventListener('change', function () {
        for (const file of file_input.files) {
            upload(file);
        }
        file_input.value = '';
        reopen_camera();
    });

    document.getElementById('done').addEventListener('click', function () {
        next.hidden = true;
    });

    report('page-loaded', navigator.userAgent);
    load_shutter_sound();
}

// diagnostics: every event lands in the server console on the laptop

function report(event, detail)
{
    fetch('client-log', {
        body: JSON.stringify({version, event, detail}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
    }).catch(() => {});
}

// save confirmation sound: the stock Android shutter click (AOSP camera_click.ogg)

async function load_shutter_sound()
{
    try {
        const res = await fetch('shutter.ogg');
        const encoded = await res.arrayBuffer();
        if (audio_context === null) {
            audio_context = new AudioContext();
        }
        shutter_buffer = await audio_context.decodeAudioData(encoded);
    } catch {
        report('shutter-sound-failed', 'using synthesized click');
    }
}

function play_click(at, frequency)
{
    const start = audio_context.currentTime + at;
    const length = Math.round(audio_context.sampleRate * 0.045);
    const buffer = audio_context.createBuffer(1, length, audio_context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
        samples[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }

    const source = audio_context.createBufferSource();
    source.buffer = buffer;
    const filter = audio_context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 1.5;
    const gain = audio_context.createGain();
    gain.gain.value = 0.8;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(audio_context.destination);
    source.start(start);
}

function play_shutter()
{
    if (audio_context === null) {
        audio_context = new AudioContext();
    }
    if (audio_context.state === 'suspended') {
        audio_context.resume();
    }
    if (shutter_buffer === null) {
        play_click(0, 2200);
        play_click(0.07, 1100);
        return;
    }
    const source = audio_context.createBufferSource();
    source.buffer = shutter_buffer;
    source.connect(audio_context.destination);
    source.start();
}

// upload

async function upload(blob)
{
    status.textContent = 'uploading…';
    try {
        const res = await fetch('upload', {
            body: blob,
            headers: {'content-type': blob.type},
            method: 'POST',
        });
        const result = await res.json();
        if (result.saved === undefined) {
            throw new Error(result.error);
        }
        saved_count += 1;
        play_shutter();
        if (navigator.vibrate) {
            navigator.vibrate(40);
        }
        show_toast(`saved ${result.saved} · ${result.kb} kB`);
        status.textContent = `${saved_count} saved this session`;
        next_count.textContent = `${saved_count} saved`;
    } catch (error) {
        report('upload-failed', error.message);
        show_toast(`upload failed: ${error.message}`);
        status.textContent = 'upload failed — try again';
    }
}

function show_toast(message)
{
    toast.textContent = message;
    toast.hidden = false;
    toast.classList.add('on');
    clearTimeout(toast_timer);
    toast_timer = setTimeout(() => toast.classList.remove('on'), 1800);
}

// relaunching the camera needs transient user activation; when Chrome denies it,
// the tap-anywhere overlay keeps the loop at one unaimed tap per receipt
function reopen_camera()
{
    try {
        file_input.showPicker();
    } catch {
        report('auto-reopen-blocked', 'showing tap-anywhere overlay');
        next.hidden = false;
    }
}
