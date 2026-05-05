export const PLAYBACK_SPEED_MIN = 0.5;
export const PLAYBACK_SPEED_MAX = 2;
export const PLAYBACK_SPEED_STEP = 0.1;
export const PLAYBACK_SPEED_DEFAULT = 1;

const SPEED_EPSILON = 1e-6;

export const clampPlaybackSpeed = (speed: number): number =>
  Math.min(PLAYBACK_SPEED_MAX, Math.max(PLAYBACK_SPEED_MIN, speed));

export const formatPlaybackSpeed = (speed: number): string => `x${clampPlaybackSpeed(speed).toFixed(1)}`;

export const roundPlaybackSpeedToStep = (speed: number): number => {
  const clamped = clampPlaybackSpeed(speed);
  const snapped = Math.round(clamped / PLAYBACK_SPEED_STEP) * PLAYBACK_SPEED_STEP;
  return Number(snapped.toFixed(1));
};

export const isPlaybackSpeedEqual = (a: number, b: number): boolean =>
  Math.abs(clampPlaybackSpeed(a) - clampPlaybackSpeed(b)) < SPEED_EPSILON;
