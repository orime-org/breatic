// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveOlderRuns,
  archiveProjects,
  MADE_BY_SMOKE,
  readProjects,
  projectId,
  projectUrl,
  type ProjectApi,
} from '../project';

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
  const slots = { '0': { A: ['one', 'two'], B: ['three'] }, '1': { A: ['four', 'five'], B: ['six'] } };

  it('hands over the id at the asked-for place in the asked-for slot', () => {
    const prepared = readProjects(fileHolding(JSON.stringify(slots)));
    expect(projectId(prepared, 0, 'A', 0)).toBe('one');
    expect(projectId(prepared, 0, 'A', 1)).toBe('two');
    expect(projectId(prepared, 0, 'B', 0)).toBe('three');
    expect(projectId(prepared, 1, 'A', 0)).toBe('four');
    expect(projectId(prepared, 1, 'B', 0)).toBe('six');
  });

  it('builds the url a spec navigates to', () => {
    const prepared = readProjects(fileHolding(JSON.stringify(slots)));
    expect(projectUrl(prepared, 1, 'A', 1)).toBe('/project/five');
  });

  it('says setup has not run when the file is missing', () => {
    // The alternative is every spec failing at its first navigation with a
    // 404, which reads as a product defect rather than as a run that never
    // had its opening built.
    expect(() => readProjects(join(tmpdir(), 'nothing-here', 'projects.json')))
      .toThrow(/setup/i);
  });

  it('rejects a file that is not the shape setup writes', () => {
    expect(() => readProjects(fileHolding(JSON.stringify({ '0': { A: 'one' } })))).toThrow(/shape/i);
    // The one-pair file an earlier suite wrote.
    expect(() => readProjects(fileHolding(JSON.stringify({ A: ['one'], B: ['two'] })))).toThrow(/shape/i);
  });

  it('names the slot, the account and the place when there is no project there', () => {
    const prepared = readProjects(fileHolding(JSON.stringify(slots)));
    expect(() => projectId(prepared, 0, 'B', 1)).toThrow(/B.*1/);
    expect(() => projectId(prepared, 2, 'A', 0)).toThrow(/slot 2/);
  });

  it('answers for the file it is given, every time it is asked', () => {
    const one = fileHolding(JSON.stringify({ '0': { A: ['one'], B: ['two'] } }));
    const other = fileHolding(JSON.stringify({ '0': { A: ['three'], B: ['four'] } }));
    expect(readProjects(one)).toEqual({ '0': { A: ['one'], B: ['two'] } });
    expect(readProjects(other)).toEqual({ '0': { A: ['three'], B: ['four'] } });
    expect(readProjects(one)).toEqual({ '0': { A: ['one'], B: ['two'] } });
  });
});

/** A project the fake studio lists. */
interface Listed {
  id: string;
  slug: string;
}

/**
 * A studio API that lists `pages` and answers each archive with `status`.
 * @param pages - The live projects, one array per page.
 * @param refuse - Project ids whose archive is answered with 409.
 * @returns The fake, and the archive calls it saw.
 */
function fakeStudio(
  pages: Listed[][],
  refuse: string[] = [],
): { api: ProjectApi; archived: string[]; posted: string[] } {
  const archived: string[] = [];
  const posted: string[] = [];
  const answer = (status: number, body: unknown) => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
  });
  const api: ProjectApi = {
    get: async (url: string) => {
      const cursor = /[?&]cursor=([^&]+)/.exec(url)?.[1];
      const at = cursor === undefined ? 0 : Number(cursor);
      return answer(200, {
        data: { items: pages[at] ?? [], nextCursor: at + 1 < pages.length ? String(at + 1) : null },
      });
    },
    post: async (url: string) => {
      posted.push(url);
      const id = /\/api\/v1\/projects\/([^/]+)\/archive$/.exec(url)?.[1] ?? '';
      if (refuse.includes(id)) return answer(409, {});
      archived.push(id);
      return answer(200, { data: { ok: true } });
    },
  };
  return { api, archived, posted };
}

describe('clearing away the projects earlier runs made', () => {
  it('archives every live project a run made, across pages, and nothing else', async () => {
    const studio = fakeStudio([
      [
        { id: 'p1', slug: `${MADE_BY_SMOKE}-1-0` },
        { id: 'mine', slug: 'my-own-work' },
      ],
      [{ id: 'p2', slug: `${MADE_BY_SMOKE}-2-1` }],
    ]);
    await archiveOlderRuns(studio.api, 'personal');
    expect(studio.archived).toEqual(['p1', 'p2']);
    expect(studio.posted).toEqual(['/api/v1/projects/p1/archive', '/api/v1/projects/p2/archive']);
  });

  it('names the project it could not archive', async () => {
    const studio = fakeStudio([[{ id: 'p1', slug: `${MADE_BY_SMOKE}-1-0` }]], ['p1']);
    await expect(archiveOlderRuns(studio.api, 'personal')).rejects.toThrow(/p1.*409/);
  });
});

describe('archiving the projects this run made', () => {
  it('answers with the ones that were not archived and why', async () => {
    const studio = fakeStudio([], ['b']);
    expect(await archiveProjects(studio.api, ['a', 'b'])).toEqual(['b (409)']);
    expect(studio.archived).toEqual(['a']);
  });
});
