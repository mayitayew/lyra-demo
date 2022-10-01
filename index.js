'use strict';

import Module from './soundstream_codec_wrapper.js';
import {HeapAudioBuffer} from "./audio_helper.js";

// Initialize the lyra codec module.
let codecModule;
Module().then((module) => {
    console.log("Initialized codec's wasmModule.");
    codecModule = module;
}).catch(e => {
    console.log(`Module() error: ${e.name} message: ${e.message}`);
});

/* global MediaStreamTrackProcessor, MediaStreamTrackGenerator, AudioData */
if (typeof MediaStreamTrackProcessor === 'undefined' ||
    typeof MediaStreamTrackGenerator === 'undefined') {
    alert(
        'Your browser does not support the experimental MediaStreamTrack API ' +
        'for Insertable Streams of Media used by this demo. Please try on the latest Chrome or Edge browsers.');
}

try {
    new MediaStreamTrackGenerator('audio');
    console.log('Audio insertable streams supported');
} catch (e) {
    alert(
        'Your browser does not support insertable audio streams. See the note ' +
        'at the bottom of the page.');
}

if (typeof AudioData === 'undefined') {
    alert(
        'Your browser does not support WebCodecs. See the note at the bottom ' +
        'of the page.');
}

// Put variables in global scope to make them available to the browser console.

// Audio element
let audio;

// Buttons
let startButton;
let stopButton;
let enableLyraButton;
let isLyraEnabled = false;
let isLyraCodecReady = false;

// Transformation chain elements
let processor;
let generator;
let transformer;

// Stream from getUserMedia
let stream;
// Output from the transform
let processedStream;

// Adjust this value to increase/decrease the amount of filtering.
// eslint-disable-next-line prefer-const
let cutoff = 100;

// An AbortController used to stop the transform.
let abortController;

// Initialize on page load.
async function init() {
    audio = document.getElementById('audioOutput');
    startButton = document.getElementById('startButton');
    stopButton = document.getElementById('stopButton');
    enableLyraButton = document.getElementById('enableLyraButton');

    startButton.onclick = start;
    stopButton.onclick = stop;

    enableLyraButton.onclick = enableDisableLyra;
    enableLyraButton.disabled = true;
}

const constraints = window.constraints = {
    audio: {
        latency: 0.01,
        channelCount: 1,
        sampleRate: 48000,
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
    },
    video: false
};

let main_buffer = new Float32Array(1920);
let copy_index = 0;
let num_copied = 0;
let start_time = 0;

// Returns an encodeAndDecode transform function for use with TransformStream.
function encodeAndDecode() {
    return (audiodata, controller) => {

        if (!isLyraCodecReady && codecModule.isCodecReady()) {
            isLyraCodecReady = true;
            enableLyraButton.disabled = false;
            console.log("Lyra codec is ready.");
        }

        if (!isLyraCodecReady || !isLyraEnabled) {
            console.log("*****Lyra codec is not in use*****.");
            controller.enqueue(audiodata);
        } else {
            console.log("*****Lyra codec is in use*****.");
            console.log("Sample rate is %d.", audiodata.sampleRate);
            console.log("Number of samples is %d.", audiodata.numberOfFrames);

            const format = 'f32-planar';
            const buffer = new Float32Array(audiodata.numberOfFrames);
            audiodata.copyTo(buffer, {planeIndex: 0, format});

            // Copy from current buffer to main buffer
            for (let i = 0; i < audiodata.numberOfFrames; i++) {
                main_buffer[copy_index] = buffer[i];
                copy_index++;
            }
            num_copied++;

            console.log("Input input samples: ", buffer);

            console.log("The combined input samples are: ", main_buffer);

            if (num_copied == 4) {
                var heapInputBuffer = new HeapAudioBuffer(codecModule, main_buffer.length, 1, 1);
                heapInputBuffer.getChannelData(0).set(main_buffer);

                var heapOutputBuffer = new HeapAudioBuffer(codecModule, main_buffer.length, 1, 1);

                const success = codecModule.encodeAndDecode(heapInputBuffer.getHeapAddress(),
                    main_buffer.length, audiodata.sampleRate,
                    heapOutputBuffer.getHeapAddress());

                if (!success) {
                    console.log("EncodeAndDecode was not successful.");
                    return;
                }

                const output_buffer = new Float32Array(main_buffer.length);
                output_buffer.set(heapOutputBuffer.getChannelData(0));

                console.log("Input buffer: ", main_buffer);
                console.log("Output buffer: ", output_buffer);

                controller.enqueue(new AudioData({
                    format: format,
                    sampleRate: audiodata.sampleRate,
                    numberOfFrames: main_buffer.length,
                    numberOfChannels: 1,
                    timestamp: start_time,
                    // A typed array of audio data.
                    data: output_buffer,
                }));
                copy_index = 0;
                num_copied = 0;
                main_buffer.fill(0);
            } else if (num_copied == 1) {
                start_time = audiodata.timestamp;
            }
        }
    };
}

async function enableDisableLyra() {
    if (isLyraEnabled) {
        isLyraEnabled = false;
        enableLyraButton.innerText = "Enable Lyra";
        console.log("Lyra disabled.");
    } else {
        isLyraEnabled = true;
        enableLyraButton.innerText = "Disable Lyra";
        console.log("Lyra enabled.");
    }
}

async function start() {
    startButton.disabled = true;
    try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
        const errorMessage =
            'navigator.MediaDevices.getUserMedia error: ' + error.message + ' ' +
            error.name;
        document.getElementById('errorMsg').innerText = errorMessage;
        console.log(errorMessage);
    }
    const audioTracks = stream.getAudioTracks();
    console.log('Using audio device: ' + audioTracks[0].label);
    console.log('Audio track capabilities: ', audioTracks[0].getCapabilities());
    stream.oninactive = () => {
        console.log('Stream ended');
    };

    processor = new MediaStreamTrackProcessor(audioTracks[0]);
    generator = new MediaStreamTrackGenerator('audio');
    const source = processor.readable;
    const sink = generator.writable;
    transformer = new TransformStream({transform: encodeAndDecode()});
    abortController = new AbortController();
    const signal = abortController.signal;
    const promise = source.pipeThrough(transformer, {signal}).pipeTo(sink);
    promise.catch((e) => {
        if (signal.aborted) {
            console.log('Shutting down streams after abort.');
        } else {
            console.error('Error from stream transform:', e);
        }
        source.cancel(e);
        sink.abort(e);
    });

    processedStream = new MediaStream();
    processedStream.addTrack(generator);
    audio.srcObject = processedStream;
    stopButton.disabled = false;
    await audio.play();
}

async function stop() {
    stopButton.disabled = true;
    audio.pause();
    audio.srcObject = null;
    stream.getTracks().forEach(track => {
        track.stop();
    });
    abortController.abort();
    abortController = null;
    startButton.disabled = false;


    if (isLyraEnabled) {
        isLyraEnabled = false;
        enableLyraButton.innerText = "Enable Lyra";
        console.log("Lyra disabled.");
    }
}

window.onload = init;