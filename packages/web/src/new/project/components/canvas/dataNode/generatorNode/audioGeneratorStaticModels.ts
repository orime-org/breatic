/**
 * Static audio generator footer: category keys ↔ labels ↔ model pills (until backend catalog wiring exists).
 */
import type { AudioGenerationMode } from '@/new/project/types';

/** Visible dropdown order — maps persisted {@link AudioGenerationMode} keys to UI labels. */
export const AUDIO_GENERATOR_MODE_ITEMS: Array<{ key: AudioGenerationMode; label: string }> = [
  { key: 'tts', label: 'TTS' },
  { key: 'lyrics-music', label: 'Song' },
  { key: 'sfx', label: 'SFX' },
  { key: 'melody', label: 'Melody' },
];

const AUDIO_MODE_KEYS = new Set(AUDIO_GENERATOR_MODE_ITEMS.map((m) => m.key));

/**
 * @param key - Persisted `generatorCategoryKey` or legacy values (`voice-clone`, unknown).
 * @returns A supported audio mode; unknown keys fall back to `tts`.
 */
export function normalizeAudioGeneratorCategoryKey(key: string): AudioGenerationMode {
  if (AUDIO_MODE_KEYS.has(key as AudioGenerationMode)) return key as AudioGenerationMode;
  /** Legacy / removed menu entries — migrate to TTS. */
  if (key === 'voice-clone') return 'tts';
  return 'tts';
}

/** Static model names per mode — switching mode picks from this map in {@link LocalGenNode}. */
export const AUDIO_MODEL_OPTIONS_BY_MODE: Record<AudioGenerationMode, readonly string[]> = {
  tts: ['Minimax Speech 02 hd', 'ElevenLabs Multilingual v2', 'Azure Neural TTS'],
  'lyrics-music': ['Suno v3 · Song', 'Udio Song', 'MusicGen Lyrics'],
  sfx: ['ElevenLabs SFX', 'Adobe Sound Pack', 'Audiobox SFX'],
  melody: ['MusicGen Melody', 'Stable Audio Instrumental', 'Hum-to-Melody XL'],
  /** Deprecated mode — keep a minimal list so persisted nodes still render. */
  'voice-clone': ['Minimax Speech 02 hd', 'ElevenLabs Voice Clone'],
};

/**
 * @param mode - Active audio generation mode.
 * @returns Default model label for that mode (first entry in static list).
 */
export function defaultModelLabelForAudioMode(mode: AudioGenerationMode): string {
  const list = AUDIO_MODEL_OPTIONS_BY_MODE[mode];
  return list[0] ?? 'Minimax Speech 02 hd';
}
