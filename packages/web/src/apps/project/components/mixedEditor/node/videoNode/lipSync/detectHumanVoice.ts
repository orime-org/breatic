export type HumanVoiceDetectInput =
  | { type: 'file'; file: File }
  | { type: 'url'; url: string };

export type HumanVoiceDetectResult = {
  hasHumanVoice: boolean;
  durationSec: number;
  reason?: string;
};

const FRAME_SIZE = 2048;
const FRAME_STEP = 1024;
const RMS_THRESHOLD = 0.018;
const VOICED_ZCR_MIN = 0.01;
const VOICED_ZCR_MAX = 0.22;
const MIN_VOICED_RATIO = 0.12;

const downMixToMono = (audioBuffer: AudioBuffer): Float32Array => {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  if (channels <= 1) return audioBuffer.getChannelData(0);
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c += 1) {
    const channelData = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) {
      mono[i] += channelData[i] / channels;
    }
  }
  return mono;
};

const computeFrameRms = (samples: Float32Array, start: number, size: number): number => {
  let sum = 0;
  for (let i = 0; i < size; i += 1) {
    const s = samples[start + i];
    sum += s * s;
  }
  return Math.sqrt(sum / size);
};

const computeFrameZcr = (samples: Float32Array, start: number, size: number): number => {
  let crossings = 0;
  let prev = samples[start];
  for (let i = 1; i < size; i += 1) {
    const curr = samples[start + i];
    if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) crossings += 1;
    prev = curr;
  }
  return crossings / size;
};

const loadInputArrayBuffer = async (input: HumanVoiceDetectInput): Promise<ArrayBuffer> => {
  if (input.type === 'file') return input.file.arrayBuffer();
  const response = await fetch(input.url, { mode: 'cors' });
  if (!response.ok) throw new Error(`Audio fetch failed: ${response.status}`);
  return response.arrayBuffer();
};

export const detectHumanVoice = async (input: HumanVoiceDetectInput): Promise<HumanVoiceDetectResult> => {
  const audioContext = new AudioContext();
  try {
    const arrayBuffer = await loadInputArrayBuffer(input);
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const mono = downMixToMono(decoded);
    const durationSec = Number.isFinite(decoded.duration) ? decoded.duration : mono.length / decoded.sampleRate;
    if (mono.length < FRAME_SIZE * 2 || durationSec < 0.5) {
      return { hasHumanVoice: false, durationSec, reason: 'Audio is too short to detect speech' };
    }

    let voicedFrames = 0;
    let totalFrames = 0;
    let speechEnergyFrames = 0;

    for (let start = 0; start + FRAME_SIZE <= mono.length; start += FRAME_STEP) {
      totalFrames += 1;
      const rms = computeFrameRms(mono, start, FRAME_SIZE);
      const zcr = computeFrameZcr(mono, start, FRAME_SIZE);
      const speechLike = rms >= RMS_THRESHOLD && zcr >= VOICED_ZCR_MIN && zcr <= VOICED_ZCR_MAX;
      if (speechLike) voicedFrames += 1;
      if (rms >= RMS_THRESHOLD) speechEnergyFrames += 1;
    }

    if (totalFrames === 0) {
      return { hasHumanVoice: false, durationSec, reason: 'Unable to analyse audio frames' };
    }

    const voicedRatio = voicedFrames / totalFrames;
    const energyRatio = speechEnergyFrames / totalFrames;
    const hasHumanVoice = voicedRatio >= MIN_VOICED_RATIO && energyRatio >= 0.2;

    return {
      hasHumanVoice,
      durationSec,
      ...(hasHumanVoice ? {} : { reason: 'No human voice detected' }),
    };
  } finally {
    await audioContext.close();
  }
};
