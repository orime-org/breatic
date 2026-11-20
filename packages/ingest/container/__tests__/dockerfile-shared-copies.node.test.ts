// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Each container image bundles its entry with esbuild inside Docker, where
 * only the shared files its Dockerfile copies exist. A value import of a
 * shared file the Dockerfile does not copy builds and tests fine on the host
 * and fails only when the image is built (wrangler dev or a deploy).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHARED = resolve(PKG, "../shared/src");
const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;

/**
 * Maps an import specifier to the source file it names.
 * @param from - File that holds the import
 * @param spec - The specifier as written
 * @returns The `.ts` path, or null for packages and Node built-ins
 */
function sourceOf(from: string, spec: string): string | null {
  let path: string;
  if (spec.startsWith("@ingest/")) path = join(PKG, "src", spec.slice("@ingest/".length));
  else if (spec.startsWith("@shared/")) path = join(SHARED, spec.slice("@shared/".length));
  else if (spec.startsWith(".")) path = resolve(dirname(from), spec);
  else return null;
  return path.replace(/\.js$/, ".ts");
}

/**
 * Walks every value import reachable from an entry.
 * @param entry - The file esbuild bundles
 * @returns Shared files reached, relative to `packages/shared/src`
 */
function sharedFilesBundled(entry: string): string[] {
  const seen = new Set<string>();
  const shared = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (match[1] !== undefined) continue;
      const target = sourceOf(file, match[2] as string);
      if (target === null) continue;
      if (target.startsWith(SHARED)) shared.add(relative(SHARED, target));
      queue.push(target);
    }
  }
  return [...shared].sort();
}

describe.each([
  ["Dockerfile", "container/server.ts"],
  ["web-animation.Dockerfile", "container/web-animation-server.ts"],
])("%s", (dockerfile, entry) => {
  it(`copies every shared file ${entry} bundles by value`, () => {
    const text = readFileSync(join(PKG, dockerfile), "utf8");
    const missing = sharedFilesBundled(join(PKG, entry)).filter(
      (file) => !text.includes(`COPY packages/shared/src/${file} /shared/src/${file}`),
    );
    expect(missing).toEqual([]);
  });
});
