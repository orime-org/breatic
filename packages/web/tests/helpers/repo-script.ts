// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Run a repository database script with the root bootstrap, hand it its input as JSON on stdin and read its JSON answer.
 * @param script - The script's path from the repository root.
 * @param input - What it reads from stdin.
 * @param label - What the error calls the run.
 * @returns Its parsed stdout.
 * @throws {Error} When it cannot start or exits with a non-zero code.
 */
export async function runRepoScript<T>(script: string, input: unknown, label: string): Promise<T> {
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', '--tsconfig', 'packages/server/tsconfig.json', script], {
      cwd: resolve(__dirname, '../../../..'), stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => { if (code === 0) resolveOutput(stdout); else reject(new Error(`${label} failed (${code}): ${stderr}`)); });
    child.stdin.end(JSON.stringify(input));
  });
  return JSON.parse(output) as T;
}
