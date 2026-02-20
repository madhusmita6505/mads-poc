/**
 * AudioWorklet processor for capturing raw PCM audio.
 *
 * Runs in the audio rendering thread for minimal latency.
 * Collects samples into a buffer and posts Int16 PCM chunks
 * to the main thread at regular intervals.
 *
 * At 24kHz (OpenAI Realtime API), 2400 samples ≈ 100ms.
 * At 48kHz (fallback), 2400 samples ≈ 50ms.
 */

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Buffer to accumulate samples before sending
    // At 24kHz, 1200 samples ≈ 50ms — lower latency for faster first transcript
    this._buffer = [];
    this._bufferSize = 1200;
  }

  /**
   * Convert Float32 samples (-1.0 to 1.0) to Int16 PCM (-32768 to 32767).
   */
  _floatTo16BitPCM(floatSamples) {
    const pcm = new Int16Array(floatSamples.length);
    for (let i = 0; i < floatSamples.length; i++) {
      const s = Math.max(-1, Math.min(1, floatSamples[i]));
      pcm[i] = s < 0 ? s * 0x8001 : s * 0x7fff;
    }
    return pcm;
  }

  /**
   * Called by the audio system with 128-sample blocks.
   */
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input.length) return true;

    // Take only the first channel (mono)
    const channelData = input[0];
    if (!channelData) return true;

    // Accumulate samples
    for (let i = 0; i < channelData.length; i++) {
      this._buffer.push(channelData[i]);
    }

    // When buffer is full, convert and send to main thread
    if (this._buffer.length >= this._bufferSize) {
      const floatSamples = new Float32Array(this._buffer);
      const pcmData = this._floatTo16BitPCM(floatSamples);

      // Transfer the underlying ArrayBuffer for zero-copy
      this.port.postMessage(pcmData.buffer, [pcmData.buffer]);

      this._buffer = [];
    }

    return true;
  }
}

registerProcessor("audio-capture-processor", AudioCaptureProcessor);
