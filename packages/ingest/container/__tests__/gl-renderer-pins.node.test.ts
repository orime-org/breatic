// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GL renderer's own modules (the `gl` stage of packages/ingest/Dockerfile) install from a committed package.json and lockfile with
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

  const dockerfile = readFileSync(resolve(HERE, '../../Dockerfile'), 'utf8');

  it('GP03 the renderer stage installs the committed lockfile with npm ci', () => {
    const stage = /^FROM [^\n]* AS gl-renderer$([\s\S]*?)^FROM /m.exec(dockerfile)?.[1] ?? '';
    expect(stage).toMatch(/^COPY packages\/ingest\/container\/gl-renderer\/package\.json packages\/ingest\/container\/gl-renderer\/package-lock\.json \.\/$/m);
    expect(stage).toMatch(/npm ci\b/);
    expect(stage).not.toMatch(/npm install\b/);
  });

  it('GP04 the GL image is the standard image plus the renderer, chosen by VARIANT in the same Dockerfile', () => {
    // A base image built apart from this Dockerfile carries whatever service it was built with, not this checkout's.
    expect(dockerfile).not.toMatch(/BASE_IMAGE/);
    expect(dockerfile).toMatch(/^ARG VARIANT=standard$/m);
    expect(dockerfile).toMatch(/^FROM \$\{ALPINE_IMAGE\} AS standard$/m);
    expect(dockerfile).toMatch(/^FROM standard AS gl$/m);
    const stages = [...dockerfile.matchAll(/^FROM .*$/gm)].map((match) => match[0]);
    expect(stages.at(-1)).toBe('FROM ${VARIANT}');
  });
});
