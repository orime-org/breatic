// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sending again once the server's rate-limit window allows it.
 *
 * Signing in is limited per address (config/rate-limits.yaml `login`), and
 * every worker of a run shares this machine's address, so cases that sign in
 * from different workers can land in the same window. The server answers 429
 * with `Retry-After` set to the seconds to wait (middleware/rate-limit.ts),
 * and that is the wait used here.
 */

/** What this reads off an answer; both API and page responses have it. */
interface Answer {
  status: () => number;
  headers: () => Record<string, string>;
}

/** How many times a refused request is sent again before giving up. */
const ATTEMPTS = 3;

/**
 * Wait for the given time.
 * @param ms - How long.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send, and while the answer is a 429, wait as long as it says and send again.
 * @param send - Sends the request and resolves with its answer.
 * @param wait - How to wait; real time unless a test passes its own.
 * @returns The first answer that is not a 429.
 * @throws {Error} When the server is still refusing after the last attempt,
 *   or a 429 carries no usable `Retry-After`.
 */
export async function whileRateLimited<T extends Answer>(
  send: () => Promise<T>,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const answer = await send();
    if (answer.status() !== 429) return answer;
    const seconds = Number(answer.headers()['retry-after']);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`The server answered 429 without a usable Retry-After (${String(answer.headers()['retry-after'])}).`);
    }
    if (attempt === ATTEMPTS) {
      throw new Error(`Still answered 429 after ${String(ATTEMPTS)} attempts, ${String(seconds)}s apart. Something else on this machine is using up the window.`);
    }
    await wait(seconds * 1000);
  }
}
