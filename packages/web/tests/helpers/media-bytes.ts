// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Media files built in the test, each one's bytes new, so an upload of it is
 * never a dedup hit on an earlier run's.
 */

import { randomBytes } from 'node:crypto';

/** How many samples the WAV holds: one second at 8 kHz. */
const SAMPLES = 8000;

/**
 * A one-second mono 16-bit 8 kHz WAV of random noise.
 * @returns The bytes.
 */
export function wavBytes(): Buffer {
  const data = randomBytes(SAMPLES * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
