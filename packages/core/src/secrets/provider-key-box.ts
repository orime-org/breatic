// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Sealing an account's own upstream key (inner#1953): AES-256-GCM with a fresh 12-byte IV per seal, written as
 * `v1:<key id>:<iv hex>:<ciphertext hex>:<tag hex>`. The key id names the master key that sealed it, so rotating the
 * current key keeps every older seal openable while its key stays in the ring. Errors never carry the key or the
 * sealed text.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CoreConfig } from "@core/config/schema.js";

/** The master keys: `current` seals, every entry of `keys` (32 bytes each) opens. */
export interface ProviderKeyRing {
  current: string;
  keys: Readonly<Record<string, Buffer>>;
}

/** Longest key an account may save. */
const MAX_KEY_LENGTH = 1024;
const PRINTABLE_KEY = /^[\x21-\x7E]+$/;
const LOWER_HEX = /^(?:[0-9a-f]{2})+$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A sealed key that cannot be opened (tampered, malformed or sealed under a key the ring lacks), or a ring that cannot seal. */
export class ProviderKeySealBroken extends Error {
  /**
   * Build the error; it never carries the key or the sealed text.
   * @returns The error.
   */
  constructor() {
    super("The provider key's seal cannot be used: it is malformed, altered, or its master key is not configured");
    this.name = "ProviderKeySealBroken";
  }
}

/** A pasted key that is empty, too long or holds a character outside printable ASCII. */
export class InvalidProviderKey extends Error {
  /**
   * Build the error; it never repeats the key.
   * @returns The error.
   */
  constructor() {
    super(`A provider key must be 1 to ${MAX_KEY_LENGTH} printable ASCII characters with no spaces or control characters`);
    this.name = "InvalidProviderKey";
  }
}

/**
 * The key as it will be stored and sent: surrounding whitespace trimmed, then checked.
 * @param raw - What the user pasted.
 * @returns The trimmed key.
 * @throws {InvalidProviderKey} When it is empty, longer than the bound or not printable ASCII.
 */
export function normalizeProviderKey(raw: string): string {
  const key = raw.trim();
  if (key.length === 0 || key.length > MAX_KEY_LENGTH || !PRINTABLE_KEY.test(key)) throw new InvalidProviderKey();
  return key;
}

/**
 * What the user is shown of a saved key: its first six and last four characters, only the last four for a key too
 * short to keep them apart, and nothing for a shorter one.
 * @param key - The key.
 * @returns The hint.
 */
export function displayHintOf(key: string): string {
  if (key.length >= 16) return `${key.slice(0, 6)}…${key.slice(-4)}`;
  if (key.length >= 8) return `…${key.slice(-4)}`;
  return "…";
}

/**
 * Seal a key with the ring's current master key.
 * @param key - The key.
 * @param ring - The master keys.
 * @returns The sealed text.
 * @throws {ProviderKeySealBroken} When the current master key is missing or not 32 bytes.
 */
export function sealProviderKey(key: string, ring: ProviderKeyRing): string {
  const master = ring.keys[ring.current];
  if (master === undefined || master.length !== 32 || ring.current.includes(":")) throw new ProviderKeySealBroken();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", master, iv);
  const ciphertext = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return ["v1", ring.current, iv.toString("hex"), ciphertext.toString("hex"), cipher.getAuthTag().toString("hex")].join(":");
}

/**
 * Open a sealed key with whichever master key sealed it.
 * @param sealed - The sealed text.
 * @param ring - The master keys.
 * @returns The key.
 * @throws {ProviderKeySealBroken} When the text is malformed or altered, or its master key is not in the ring.
 */
export function openProviderKey(sealed: string, ring: ProviderKeyRing): string {
  const parts = sealed.split(":");
  if (parts.length !== 5) throw new ProviderKeySealBroken();
  const [version, kid, ivHex, ctHex, tagHex] = parts as [string, string, string, string, string];
  const master = Object.hasOwn(ring.keys, kid) ? ring.keys[kid] : undefined;
  if (
    version !== "v1" || master === undefined || master.length !== 32 ||
    !LOWER_HEX.test(ivHex) || !LOWER_HEX.test(ctHex) || !LOWER_HEX.test(tagHex) ||
    ivHex.length !== IV_BYTES * 2 || tagHex.length !== TAG_BYTES * 2
  ) {
    throw new ProviderKeySealBroken();
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", master, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
  } catch {
    // The cipher's own error says nothing about the key, but is replaced so no caller ever has to check.
    throw new ProviderKeySealBroken();
  }
}

/**
 * The master key ring a deployment configured, or null when bring-your-own-key is off (neither variable set).
 * `parseConfig` has already refused a half or malformed configuration.
 * @param config - The parsed core configuration.
 * @returns The ring, or null.
 */
export function providerKeyRingOf(config: Pick<CoreConfig, "PROVIDER_KEY_SECRET_ID" | "PROVIDER_KEY_SECRETS">): ProviderKeyRing | null {
  if (config.PROVIDER_KEY_SECRET_ID === "") return null;
  return {
    current: config.PROVIDER_KEY_SECRET_ID,
    keys: Object.fromEntries(Object.entries(config.PROVIDER_KEY_SECRETS).map(([id, hex]) => [id, Buffer.from(hex, "hex")])),
  };
}
