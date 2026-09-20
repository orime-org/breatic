// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProjects, projectId, projectUrl } from '../project';

const made: string[] = [];

/**
 * Writes a projects file into a throwaway directory.
 * @param content - What to put in the file, already stringified.
 * @returns The path of the file.
 */
function fileHolding(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'projects-'));
  made.push(dir);
  const path = join(dir, 'projects.json');
  writeFileSync(path, content, 'utf8');
  return path;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the projects setup prepared', () => {
  it('hands over the id at the asked-for place', () => {
    const path = fileHolding(JSON.stringify({ A: ['one', 'two'], B: ['three'] }));
    const prepared = readProjects(path);
    expect(projectId(prepared, 'A', 0)).toBe('one');
    expect(projectId(prepared, 'A', 1)).toBe('two');
    expect(projectId(prepared, 'B', 0)).toBe('three');
  });

  it('builds the url a spec navigates to', () => {
    const path = fileHolding(JSON.stringify({ A: ['one'], B: ['three'] }));
    expect(projectUrl(readProjects(path), 'A', 0)).toBe('/project/one');
  });

  it('says setup has not run when the file is missing', () => {
    // The alternative is every spec failing at its first navigation with a
    // 404, which reads as a product defect rather than as a run that never
    // had its opening built.
    expect(() => readProjects(join(tmpdir(), 'nothing-here', 'projects.json')))
      .toThrow(/setup/i);
  });

  it('rejects a file that is not the shape setup writes', () => {
    const path = fileHolding(JSON.stringify({ A: 'one' }));
    expect(() => readProjects(path)).toThrow(/shape/i);
  });

  it('names the account and the place when there is no project there', () => {
    const path = fileHolding(JSON.stringify({ A: ['one', 'two'], B: ['three'] }));
    const prepared = readProjects(path);
    expect(() => projectId(prepared, 'B', 1)).toThrow(/B.*1/);
  });

  it('answers for the file it is given, every time it is asked', () => {
    const one = fileHolding(JSON.stringify({ A: ['one'], B: ['two'] }));
    const other = fileHolding(JSON.stringify({ A: ['three'], B: ['four'] }));
    expect(readProjects(one)).toEqual({ A: ['one'], B: ['two'] });
    expect(readProjects(other)).toEqual({ A: ['three'], B: ['four'] });
    expect(readProjects(one)).toEqual({ A: ['one'], B: ['two'] });
  });
});
