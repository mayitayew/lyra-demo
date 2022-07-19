'use strict';

import Module from './webassembly_codec_wrapper.js';
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


// Lyra encodes/decodes in frames of 40ms. Audio is being acquired in 10ms chunks. Thus we need to
// accumulate four audio chunks to have a buffer of 40ms that can be processed by Lyra.
const kNumRequiredFrames = 20;
const kNumSamplesPerFrame = 480;
const kNumRequiredSamples = kNumSamplesPerFrame * kNumRequiredFrames;
let buffer = new Float32Array(kNumRequiredSamples);
let buffer_index = 0;
let num_frames_copied = 0;
let initial_frame_start_time = 0;

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
            const format = 'f32-planar';

            const current_buffer = new Float32Array(audiodata.numberOfFrames);
            audiodata.copyTo(current_buffer, {planeIndex: 0, format});

            // Copy from current buffer to accumulator buffer.
            for (let i = 0; i < audiodata.numberOfFrames; i++) {
                buffer[buffer_index % kNumRequiredSamples] = current_buffer[i];
                buffer_index++;
            }
            num_frames_copied++;
            if (num_frames_copied % kNumRequiredFrames == 0) {
                // We have enough frames to encode and decode.
                var heapInputBuffer = new HeapAudioBuffer(codecModule, kNumRequiredSamples, 1, 1);
                heapInputBuffer.getChannelData(0).set(buffer);

                var heapOutputBuffer = new HeapAudioBuffer(codecModule, kNumRequiredSamples, 1, 1);

                const success = codecModule.encodeAndDecode(heapInputBuffer.getHeapAddress(),
                    kNumRequiredSamples, audiodata.sampleRate,
                    heapOutputBuffer.getHeapAddress());

                if (!success) {
                    console.log("EncodeAndDecode was not successful.");
                    return;
                }

                const output_buffer = new Float32Array(kNumRequiredSamples);
                output_buffer.set(heapOutputBuffer.getChannelData(0));

                controller.enqueue(new AudioData({
                    format: format,
                    sampleRate: audiodata.sampleRate,
                    numberOfFrames: kNumRequiredSamples,  // Frames in the audioData object are individual samples.
                    numberOfChannels: 1,
                    timestamp: initial_frame_start_time,
                    // A typed array of audio data.
                    data: output_buffer,
                }));
            } else if (num_frames_copied % kNumRequiredFrames == 1) {
                initial_frame_start_time = audiodata.timestamp;
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