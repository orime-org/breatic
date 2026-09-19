// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The default smoke run, and a line saying what it left out.
 *
 * `--grep-invert` removes the tagged cases from the selection, and a case
 * outside the selection has no node in the report at all — it is not listed,
 * not counted, not skipped. So a run that covers 48 of 68 cases prints the
 * same clean ending as one that covers all 68, and the "nothing went
 * unexecuted" check is satisfied by cases that were never offered.
 *
 * Listing the tagged cases first is what makes the gap visible. `--list`
 * starts no browser, so the extra pass costs a fraction of a second, and the
 * figures are counted from the suite rather than written down somewhere that
 * can drift from it.
 */
import { spawnSync } from 'node:child_process';

/** The prefix every scenario tag shares (see eslint-rules/src/scenario-tags.ts). */
const TAG_PREFIX = '@needs-';

/** Finds the tags in a case title. */
const TAG = /@needs-[\w-]+/g;

/**
 * Runs playwright, capturing what it writes so this script can read it.
 * @param {string[]} args - Arguments after `playwright`.
 * @returns {{ status: number, stdout: string }} Exit code and standard output.
 */
function readPlaywright(args) {
  const run = spawnSync('playwright', args, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  return { status: run.status ?? 1, stdout: run.stdout ?? '' };
}

/**
 * Runs playwright with its output going straight to the terminal.
 *
 * The suite takes minutes, so its progress belongs on the screen as it
 * happens rather than in one block at the end.
 * @param {string[]} args - Arguments after `playwright`.
 * @returns {number} The exit code.
 */
function runPlaywright(args) {
  return spawnSync('playwright', args, { stdio: 'inherit' }).status ?? 1;
}

/**
 * Counts the cases each tag keeps out of the default run.
 * @returns {{ total: number, byTag: Map<string, number> } | null} The counts,
 *   or null when the listing could not be read.
 */
function countExcluded() {
  const listed = readPlaywright([
    'test',
    '--project=smoke',
    `--grep=${TAG_PREFIX}`,
    '--list',
    '--reporter=json',
  ]);
  let report;
  try {
    report = JSON.parse(listed.stdout);
  } catch {
    return null;
  }

  const byTag = new Map();
  let total = 0;
  /**
   * Walks a suite and its children, counting the tags on every case.
   * @param {{ specs?: unknown[], suites?: unknown[] }} suite - A node of the report.
   */
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      total += 1;
      for (const tag of String(spec.title).match(TAG) ?? []) {
        byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return { total, byTag };
}

const excluded = countExcluded();
if (excluded === null) {
  console.log(
    '[smoke] could not list the tagged cases, so this run does not say what it left out',
  );
} else if (excluded.total === 0) {
  console.log('[smoke] no case carries a scenario tag: this run covers all of them');
} else {
  const spelled = [...excluded.byTag]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, count]) => `${tag} ${count}`)
    .join(' · ');
  console.log(
    `[smoke] leaving out ${excluded.total} case(s) that need a service this machine may not have: ${spelled}`,
  );
  console.log(
    '[smoke] run them with `pnpm test:smoke:all`, or one service at a time with `playwright test --project=smoke --grep "@needs-<service>"`',
  );
}

process.exit(
  runPlaywright([
    'test',
    '--project=smoke',
    `--grep-invert=${TAG_PREFIX}`,
    ...process.argv.slice(2),
  ]),
);
