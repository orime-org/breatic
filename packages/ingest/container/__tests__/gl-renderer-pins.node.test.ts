// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The GL renderer's own modules (packages/ingest/Dockerfile.gl) install from a committed package.json and lockfile with
 * `npm ci`, so no transitive version floats between image builds; the export draws the preview's shaders only while the
 * renderer pins the `gl-transition` and `gl-transitions` versions web pins.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER = resolve(HERE, '../gl-renderer');

/**
 * Read a JSON file.
 * @param path - The file.
 * @returns Its value.
 */
function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('the GL renderer modules', () => {
  const renderer = json<{ dependencies: Record<string, string> }>(resolve(RENDERER, 'package.json'));
  const lock = json<{ lockfileVersion: number; packages: Record<string, { version?: string; dependencies?: Record<string, string> }> }>(resolve(RENDERER, 'package-lock.json'));
  const web = json<{ dependencies: Record<string, string> }>(resolve(HERE, '../../../web/package.json'));

  it('GP01 pins gl-transition and gl-transitions at exactly the versions web pins', () => {
    for (const name of ['gl-transition', 'gl-transitions']) expect(renderer.dependencies[name], name).toBe(web.dependencies[name]);
  });

  it('GP02 pins every direct module to one exact version, and the lockfile installs those versions', () => {
    expect(Object.keys(renderer.dependencies).sort()).toEqual(['gl', 'gl-transition', 'gl-transitions']);
    for (const [name, version] of Object.entries(renderer.dependencies)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
    expect(lock.packages['']?.dependencies).toEqual(renderer.dependencies);
  });

  it('GP03 the image installs the committed lockfile with npm ci', () => {
    const dockerfile = readFileSync(resolve(HERE, '../../Dockerfile.gl'), 'utf8');
    expect(dockerfile).toMatch(/^COPY packages\/ingest\/container\/gl-renderer\/package\.json packages\/ingest\/container\/gl-renderer\/package-lock\.json \.\/$/m);
    expect(dockerfile).toMatch(/npm ci\b/);
    expect(dockerfile).not.toMatch(/npm install\b/);
  });
});
