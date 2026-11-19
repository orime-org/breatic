// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Encode a mask as COCO compressed counts, as the COCO reference's `rleToString` writes them: column-major runs starting
 * with background, each run after the second written as its difference from the run two before, five bits per character.
 * @param width - The frame width.
 * @param height - The frame height.
 * @param foreground - Whether a pixel is the person's foreground.
 * @returns The counts string.
 */
export function cocoCounts(width: number, height: number, foreground: (x: number, y: number) => boolean): string {
  const runs: number[] = [];
  let current = false;
  let length = 0;
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      if (foreground(x, y) !== current) { runs.push(length); length = 0; current = !current; }
      length += 1;
    }
  }
  runs.push(length);
  let out = '';
  runs.forEach((count, at) => {
    let value = at > 2 ? count - runs[at - 2]! : count;
    let more = true;
    while (more) {
      let code = value & 0x1f;
      value >>= 5;
      more = (code & 0x10) !== 0 ? value !== -1 : value !== 0;
      if (more) code |= 0x20;
      out += String.fromCharCode(code + 48);
    }
  });
  return out;
}
