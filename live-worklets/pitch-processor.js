import { detectPitch } from "./yin.js?v=4";

const minimumLiveRms = 0.0025;

function hasClearPitch(result) {
  return (
    result.hz !== null && (result.rms >= 0.006 || result.confidence >= 0.94)
  );
}

class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "gain",
        defaultValue: 1,
        minValue: 0.25,
        maxValue: 2,
        automationRate: "k-rate",
      },
      {
        name: "noiseGate",
        defaultValue: 0,
        minValue: 0,
        maxValue: 2,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this.buffer = new Float32Array(1024);
    this.scratch = new Float32Array(512);
    this.writeIndex = 0;
    this.sampleCount = 0;
    this.sum = 0;
    this.step = Math.max(1, Math.round(sampleRate / 12000));
    this.hop = 0;
    this.ready = false;
    this.inputPeak = 0;
    this.peak = 0;
    this.noiseFloor = 0.002;
    this.ordered = new Float32Array(1024);
    this.recent = this.ordered.subarray(512);
  }
  process(inputs, _outputs, parameters) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    try {
      const gain = parameters.gain[0];
      const noiseGate = Math.round(parameters.noiseGate?.[0] ?? 0);
      for (let i = 0; i < input.length; i++) {
        const sample = input[i];
        const adjusted = sample * gain;
        this.inputPeak = Math.max(this.inputPeak, Math.abs(sample));
        this.peak = Math.max(this.peak, Math.abs(adjusted));
        this.sum += adjusted;
        if (++this.sampleCount < this.step) continue;
        this.buffer[this.writeIndex++] = this.sum / this.step;
        this.sum = 0;
        this.sampleCount = 0;
        if (this.writeIndex === this.buffer.length) {
          this.writeIndex = 0;
          this.ready = true;
        }
        if (++this.hop < 512 || !this.ready) continue;
        this.hop = 0;
        // YIN uses time differences: a cyclic rotation introduces one boundary,
        // so restore chronological sample order before analysing.
        for (let j = 0; j < 1024; j++)
          this.ordered[j] = this.buffer[(this.writeIndex + j) % 1024];
        const analysisRate = sampleRate / this.step;
        const gateActive = noiseGate > 0;
        const floorCap = noiseGate >= 2 ? 0.05 : 0.03;
        const floorMultiplier = noiseGate >= 2 ? 3.2 : 2.2;
        const floorMinRms = noiseGate >= 2 ? 0.005 : minimumLiveRms;
        let result = detectPitch(
          this.ordered,
          analysisRate,
          this.scratch,
          minimumLiveRms,
        );
        if (!hasClearPitch(result)) {
          // A long window can contain two notes. Retry with just its newest half.
          const recent = detectPitch(
            this.recent,
            analysisRate,
            this.scratch,
            minimumLiveRms,
          );
          result = hasClearPitch(recent)
            ? recent
            : { ...result, hz: null, confidence: 0 };
        }
        if (gateActive) {
          const rms = result.rms ?? 0;
          const voiced = result.hz !== null && result.confidence >= 0.85;
          if (rms < this.noiseFloor) {
            this.noiseFloor += (rms - this.noiseFloor) * 0.2;
          } else if (!voiced) {
            const target = Math.min(rms, floorCap);
            this.noiseFloor += (target - this.noiseFloor) * 0.06;
          }
          const gateThreshold = Math.max(floorMinRms, this.noiseFloor * floorMultiplier);
          const strongClearVocal = noiseGate === 1 && result.confidence >= 0.96 && rms >= minimumLiveRms;
          if (rms < gateThreshold && !strongClearVocal) {
            result = { ...result, hz: null, confidence: 0 };
          }
        }
        this.port.postMessage({
          ...result,
          inputPeak: this.inputPeak,
          peak: this.peak,
        });
        this.inputPeak = 0;
        this.peak = 0;
      }
    } catch (error) {
      this.port.postMessage({ error: String(error) });
      return false;
    }
    return true;
  }
}
registerProcessor("intonavio-pitch", PitchProcessor);
