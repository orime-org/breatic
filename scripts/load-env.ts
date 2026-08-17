// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Finds the repository root and loads `.env` into `process.env`.
 *
 * Written out rather than taken from `dotenv`, which the repository root does
 * not depend on: a script that runs before anything is installed should not
 * need a package to read a file of `KEY=value` lines. Shared by the scripts
 * that talk to the database so there is one loader rather than a copy per
 * script — the second one is what made this a module.
 */

import { resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/**
 * Walks up from this file until it finds the workspace marker.
 * @returns The repository root, or the process's directory if none is found.
 */
export function findRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Reads `<root>/.env` into `process.env`, leaving existing values alone.
 *
 * A value already in the environment wins: whoever exported it meant it, and
 * a file on disk should not quietly override the shell.
 * @param root The repository root.
 */
export function loadEnv(root: string): void {
  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip inline comments outside quoted values
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIndex = value.indexOf(" #");
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
    }
    value = value.replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
