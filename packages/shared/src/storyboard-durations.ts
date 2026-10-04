// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a storyboard's shot durations move when the reader edits them.
 *
 * Kling fails a run whose shot durations do not add up to the top-level
 * duration (probed 2026-09-30), so every edit here keeps each shot at 1 second
 * or more and the sum equal to the total — whenever there are no more shots
 * than seconds. With more shots than seconds (the total was lowered while the
 * shots were hidden) no split exists, so the shots stay as they are and the
 * execute gate says why the run cannot go.
 *
 * Every function is pure over whole-second durations and returns a new array;
 * `null` means the action is not available right now.
 */

/**
 * Splits a total evenly, the remainder going to the last shots.
 * @param n - How many shots.
 * @param total - The total seconds.
 * @returns The durations.
 */
function splitEven(n: number, total: number): number[] {
  const base = Math.floor(total / n);
  const out = Array.from({ length: n }, () => base);
  for (let i = 0; i < total - base * n; i++) out[n - 1 - i] = (out[n - 1 - i] ?? 0) + 1;
  return out;
}

/**
 * Re-splits the shots to a new total in proportion, each at least 1 second;
 * what rounding leaves over is settled from the last shot backwards.
 * @param durations - The current durations.
 * @param total - The new total seconds.
 * @returns The re-split durations, or the current ones when there are more shots than seconds.
 */
export function retotal(durations: readonly number[], total: number): number[] {
  const n = durations.length;
  if (n === 0 || n > total) return [...durations];
  const was = durations.reduce((a, b) => a + b, 0) || 1;
  const out = durations.map((d) => Math.max(1, Math.floor((d * total) / was)));
  let diff = total - out.reduce((a, b) => a + b, 0);
  for (let i = n - 1; diff !== 0; i = (i - 1 + n) % n) {
    const d = out[i] ?? 1;
    if (diff > 0) {
      out[i] = d + 1;
      diff--;
    } else if (d > 1) {
      out[i] = d - 1;
      diff++;
    }
  }
  return out;
}

/**
 * The durations on entering the multi-shot mode: two even shots when there are
 * none yet, otherwise the existing ones re-split to the total if they drifted.
 * @param durations - The stored durations.
 * @param total - The total seconds.
 * @returns The durations to show.
 */
export function enterCustom(durations: readonly number[], total: number): number[] {
  if (durations.length === 0) return splitEven(2, total);
  const sum = durations.reduce((a, b) => a + b, 0);
  return sum === total ? [...durations] : retotal(durations, total);
}

/**
 * Adds a shot of ⌊total / n⌋ seconds (n counted after adding), taken a second
 * at a time from the longest shot, none going below 1 second.
 * @param durations - The current durations.
 * @param total - The total seconds.
 * @param maxShots - The model's shot cap.
 * @returns The durations with the new shot last, or null when at the cap or when every shot is at 1 second.
 */
export function addShot(
  durations: readonly number[],
  total: number,
  maxShots: number,
): number[] | null {
  const n = durations.length + 1;
  if (n > maxShots || total <= durations.length) return null;
  const out = [...durations];
  const want = Math.floor(total / n);
  let got = 0;
  while (got < want) {
    const longest = out.reduce((best, d, i) => (d > (out[best] ?? 0) ? i : best), 0);
    if ((out[longest] ?? 0) <= 1) break;
    out[longest] = (out[longest] ?? 0) - 1;
    got++;
  }
  out.push(Math.max(1, got));
  // A list whose seconds drifted from the total (two collaborators editing at
  // once) is re-split here, so the new shot never lands at 0 seconds.
  return enterCustom(out, total);
}

/**
 * Moves one second into or out of a shot. A second added is taken from the
 * next shot above 1 second, looking forwards and then backwards; a second
 * removed goes to the next shot, or to the previous one for the last shot.
 * @param durations - The current durations.
 * @param index - The shot being stepped.
 * @param delta - +1 or -1.
 * @returns The new durations, or null when the step is not possible.
 */
export function stepShot(
  durations: readonly number[],
  index: number,
  delta: 1 | -1,
): number[] | null {
  const out = [...durations];
  const order: number[] = [];
  for (let k = index + 1; k < out.length; k++) order.push(k);
  for (let k = index - 1; k >= 0; k--) order.push(k);
  if (delta > 0) {
    const from = order.find((k) => (out[k] ?? 0) > 1);
    if (from === undefined) return null;
    out[from] = (out[from] ?? 0) - 1;
    out[index] = (out[index] ?? 0) + 1;
    return out;
  }
  const to = order[0];
  if ((out[index] ?? 0) <= 1 || to === undefined) return null;
  out[index] = (out[index] ?? 0) - 1;
  out[to] = (out[to] ?? 0) + 1;
  return out;
}

/**
 * Removes a shot, giving its seconds to the previous shot (the first shot's to
 * the new first), then re-splits to the total once the shots fit in it.
 * @param durations - The current durations.
 * @param index - The shot to remove.
 * @param total - The total seconds.
 * @returns The new durations, or null for the last remaining shot.
 */
export function removeShot(
  durations: readonly number[],
  index: number,
  total: number,
): number[] | null {
  if (durations.length <= 1) return null;
  const out = [...durations];
  const [gone] = out.splice(index, 1);
  const heir = Math.max(0, index - 1);
  out[heir] = (out[heir] ?? 0) + (gone ?? 0);
  const sum = out.reduce((a, b) => a + b, 0);
  return sum !== total && out.length <= total ? retotal(out, total) : out;
}
