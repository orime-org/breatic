// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Project page asks the server again only when a live update says something changed (#1580, test spec area M;
 * design §6): among the modules the page imports, the only timed reads are the Agent panel's running-conversation
 * query, the chat session sync and the version check. Modules the Studio page shares (the bell, the upload table)
 * are in scope because the Project page imports them too.
 *
 * A timed read is a `refetchInterval`, or a `setTimeout` / `setInterval` whose callback, or a function of the same
 * file it calls, invalidates or refetches a query, calls one of our API modules, sends a request or awaits one
 * (judgement #18: a timer that only moves the screen, or a sleep, is not one).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = path.join(import.meta.dirname, '..', '..', '..');
const ENTRY = path.join(WEB, 'pages', 'project', 'ProjectPage.tsx');

/** The only modules of the Project page allowed a timed read, relative to `src`. */
const ALLOWED = [
  'data/deployment/use-app-update.ts',
  'pages/project/chat/use-running-conversations.ts',
  'stores/chat-live.ts',
];

/**
 * The web source file an import names, if it is one of ours.
 * @param from - The importing file.
 * @param spec - The import specifier.
 * @returns The file, or undefined for a package.
 */
function resolveImport(from: string, spec: string): string | undefined {
  const base = spec.startsWith('@web/') ? path.join(WEB, spec.slice('@web/'.length)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : undefined;
  if (base === undefined) return undefined;
  return [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx'), base].find(
    (file) => /\.tsx?$/.test(file) && existsSync(file) && statSync(file).isFile(),
  );
}

/**
 * Every module the Project page imports, itself included, as `src`-relative path to text.
 * @returns The modules.
 */
function projectPageModules(): Map<string, string> {
  const seen = new Map<string, string>();
  const pending = [ENTRY];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(path.relative(WEB, file)) || /__tests__/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    seen.set(path.relative(WEB, file), text);
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const next = resolveImport(file, match[1] as string);
      if (next !== undefined) pending.push(next);
    }
  }
  return seen;
}

/**
 * The text inside the parentheses that open at `open`.
 * @param text - The source.
 * @param open - Index of the `(`.
 * @returns What lies between it and its matching `)`.
 */
function insideParens(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/**
 * The body of a function declared in the same file under `name`, if any.
 * @param text - The source.
 * @param name - The function's name.
 * @returns Its text from the declaration to its closing brace, or null when the file declares none.
 */
function localFunction(text: string, name: string): string | null {
  const at = text.search(new RegExp(`(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\s*=)`));
  if (at < 0) return null;
  const open = text.indexOf('{', at);
  if (open < 0) return text.slice(at, at + 400);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(at, i + 1);
    }
  }
  return text.slice(at);
}

/** What a timer's work may not reach: a query invalidated or refetched, one of our API modules, a request. */
const SERVER_READ = /invalidateQueries|\brefetch\w*\s*\(|\w+Api\.\w+\s*\(|\bapi(?:Get|Post|Put|Patch|Delete)\s*\(|\bfetch\w*\s*\(|\bawait\b/;

/**
 * Whether code a timer runs reaches the server, following the file's own functions it calls.
 * @param text - The module's source.
 * @param code - The code the timer runs.
 * @param seen - Functions already followed.
 * @param depth - How many calls deep this is.
 * @returns True when it does.
 */
function reachesServer(text: string, code: string, seen: Set<string>, depth: number): boolean {
  if (SERVER_READ.test(code)) return true;
  if (depth >= 3) return false;
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1] as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const body = localFunction(text, name);
    if (body !== null && reachesServer(text, body, seen, depth + 1)) return true;
  }
  return false;
}

/**
 * Whether a module reads the server again on a timer.
 * @param text - The module's source.
 * @returns True when it does.
 */
export function readsOnATimer(text: string): boolean {
  if (/\brefetchInterval\b/.test(text)) return true;
  for (const match of text.matchAll(/\bset(?:Timeout|Interval)\s*\(/g)) {
    const callback = insideParens(text, (match.index ?? 0) + match[0].length - 1);
    const named = /^\s*([A-Za-z_$][\w$.]*)\s*,/.exec(callback)?.[1];
    if (named !== undefined) {
      // A callback handed in from elsewhere (a Promise's resolve, a caller's tick) is judged where it is written.
      const body = named.includes('.') ? null : localFunction(text, named);
      if (body !== null && reachesServer(text, body, new Set([named]), 1)) return true;
      continue;
    }
    if (reachesServer(text, callback, new Set(), 0)) return true;
  }
  return false;
}

/**
 * The modules that read the server on a timer.
 * @param modules - Path to text.
 * @returns Their paths, sorted.
 */
function offenders(modules: Map<string, string>): string[] {
  return [...modules].filter(([, text]) => readsOnATimer(text)).map(([file]) => file).sort();
}

describe('the Project page', () => {
  const modules = projectPageModules();

  it('M-01 and M-02 reads on a timer only in the allowed modules', () => {
    expect(offenders(modules).filter((file) => !ALLOWED.includes(file))).toEqual([]);
  });

  it('M-03 allows exactly the Agent panel query, the chat session sync and the version check, each of which does', () => {
    expect(ALLOWED.filter((file) => modules.has(file) && readsOnATimer(modules.get(file)!))).toEqual(ALLOWED);
  });

  it('M-06 takes in the modules it shares with the Studio page', () => {
    expect(modules.has('features/notifications/BellMenu.tsx')).toBe(true);
    expect(modules.has('data/upload/upload-status.ts')).toBe(true);
  });
});

describe('the guard', () => {
  it('M-04 reports a module with a refetchInterval', () => {
    const fixture = new Map([['features/fixture/use-fixture.ts', 'useQuery({ queryKey: [\'x\'], queryFn, refetchInterval: 30_000 });']]);
    expect(offenders(fixture)).toEqual(['features/fixture/use-fixture.ts']);
  });

  it('M-05 reports a timer that invalidates a query', () => {
    const fixture = new Map([['features/fixture/use-fixture.ts', 'setTimeout(() => queryClient.invalidateQueries({ queryKey: [\'x\'] }), 1000);']]);
    expect(offenders(fixture)).toEqual(['features/fixture/use-fixture.ts']);
  });

  it('M-05 reports a timer that calls a function of its own file which asks the server', () => {
    const text = 'async function round() { await assetsApi.fetchThing(keys); }\nsetTimeout(() => { void round(); }, 2000);';
    expect(readsOnATimer(text)).toBe(true);
  });

  it('leaves a timer that only moves the screen', () => {
    expect(readsOnATimer('const t = setTimeout(() => setOpen(false), 250);')).toBe(false);
    expect(readsOnATimer('setInterval(() => setNow(Date.now()), 60_000);')).toBe(false);
    expect(readsOnATimer('await new Promise((resolve) => setTimeout(resolve, 100));')).toBe(false);
  });
});

/** Make sure every listed module exists, so a rename cannot quietly empty the allowed list. */
describe('the allowed modules', () => {
  it('exist', () => {
    for (const file of ALLOWED) expect(readdirSync(path.dirname(path.join(WEB, file)))).toContain(path.basename(file));
  });
});
