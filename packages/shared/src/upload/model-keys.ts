// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The payer's own model keys of a web-animation job, as our worker sends them to the ingest Worker (inner#1953): a map
 * `{ [upstream]: key }` sealed as a compact JWE (RFC 7516, `RSA-OAEP-256` + `A256GCM`) to the Worker's public key, so
 * only the Worker's private key opens it. Both ends call these functions on two runtimes, so the format is written
 * here once.
 *
 * Nothing here puts a key into an error: a failure to open is {@link ModelKeysUnreadable}, with no cause attached.
 */

import { CompactEncrypt, compactDecrypt, importPKCS8, importSPKI } from "jose";
import { z } from "zod";

const ALG = "RSA-OAEP-256";
const ENC = "A256GCM";

/** Sealed keys that could not be opened or read; it carries no cause, so no key reaches a log through it. */
export class ModelKeysUnreadable extends Error {
  /**
   * Name the failure.
   */
  constructor() {
    super("The sealed model keys could not be opened");
    this.name = "ModelKeysUnreadable";
  }
}

/**
 * A PEM as an environment variable may hold it: on one line, its line breaks written as `\n`.
 * @param pem - The value.
 * @returns The PEM with real line breaks.
 * @throws {never} Never.
 */
function pemOf(pem: string): string {
  return pem.replace(/\\n/g, "\n").trim();
}

/**
 * Seal a map of upstream to key for the Worker.
 * @param keys - The keys, by upstream.
 * @param publicKeyPem - The Worker's public key, SPKI PEM.
 * @returns The compact JWE.
 * @throws {Error} When the public key cannot be read.
 */
export async function sealModelKeys(keys: Readonly<Record<string, string>>, publicKeyPem: string): Promise<string> {
  const key = await importSPKI(pemOf(publicKeyPem), ALG);
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(keys)))
    .setProtectedHeader({ alg: ALG, enc: ENC })
    .encrypt(key);
}

/**
 * Open what {@link sealModelKeys} sealed.
 * @param sealed - The compact JWE.
 * @param privateKeyPem - The Worker's private key, PKCS#8 PEM.
 * @returns The keys, by upstream.
 * @throws {ModelKeysUnreadable} When the key cannot be read, the seal does not open, or it holds no map of strings.
 */
export async function openModelKeys(sealed: string, privateKeyPem: string): Promise<Record<string, string>> {
  let payload: unknown;
  try {
    const key = await importPKCS8(pemOf(privateKeyPem), ALG);
    const { plaintext } = await compactDecrypt(sealed, key, { keyManagementAlgorithms: [ALG], contentEncryptionAlgorithms: [ENC] });
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    // Dropped on purpose: no cause of a failed open is passed on, so nothing about the keys can reach a log.
    throw new ModelKeysUnreadable();
  }
  if (!z.record(z.string(), z.string()).safeParse(payload).success) throw new ModelKeysUnreadable();
  // Rebuilt from the parsed text's own entries: an upstream named `__proto__` stays an entry, which assigning it into
  // a new object (as the schema's output does) would turn into a prototype.
  const entries = Object.entries(payload as object);
  if (!entries.every(([, key]) => typeof key === "string")) throw new ModelKeysUnreadable();
  return Object.fromEntries(entries);
}
