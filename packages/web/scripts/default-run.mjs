// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A default run of one project, and a line saying what it left out.
 *
 * `--grep-invert` removes the tagged cases from the selection, and a case
 * outside the selection has no node in the report at all — it is not listed,
 * not counted, not skipped. So a run covering part of the suite prints the
 * same clean ending as one covering all of it, and the "nothing went
 * unexecuted" check is satisfied by cases that were never offered.
 *
 * Listing the tagged cases first is what makes the gap visible. `--list`
 * starts no browser, so the extra pass costs a fraction of a second, and the
 * figures are counted from the suite rather than written down somewhere that
 * can drift from it.
 *
 * Both suites reach services a machine may not have, so both are run through
 * here:
 *
 *   node scripts/default-run.mjs smoke [playwright args]
 *   node scripts/default-run.mjs chromium [playwright args]
 */
import { spawnSync } from 'node:child_process';

/** The prefix every scenario tag shares (see eslint-rules/src/scenario-tags.ts). */
const TAG_PREFIX = '@needs-';

/** Finds the tags in a case title. */
const TAG = /@needs-[\w-]+/g;

/** Which playwright project to run, and what the rest of the arguments are. */
const [project, ...forwarded] = process.argv.slice(2);
if (project === undefined || project.startsWith('-')) {
  console.error('usage: default-run.mjs <playwright project> [playwright args]');
  process.exit(2);
}

/** What the all-inclusive run of this project is called in package.json. */
const ALL_SCRIPT = project === 'smoke' ? 'test:smoke:all' : 'test:visual:all';

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
 * Counts the cases in one selection of this project.
 *
 * Only the cases belonging to this project are counted, which each one names
 * for itself. `--grep` does not reach the projects this one depends on, so
 * setup and teardown are in every listing, and counting them would both
 * report two cases as left out that the default run goes on to execute and
 * leave the two figures below on different footings.
 * @param {string} filter - The `--grep` or `--grep-invert` argument.
 * @returns {{ total: number, byTag: Map<string, number> } | null} The counts,
 *   or null when the listing could not be read.
 */
function count(filter) {
  const listed = readPlaywright([
    'test',
    `--project=${project}`,
    filter,
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
   * Walks a suite and its children, counting its cases and their tags.
   * @param {{ specs?: unknown[], suites?: unknown[] }} suite - A node of the report.
   */
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const mine = (spec.tests ?? []).some((t) => t.projectName === project);
      if (!mine) continue;
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

const excluded = count(`--grep=${TAG_PREFIX}`);
const covered = count(`--grep-invert=${TAG_PREFIX}`);

/** Says what this run covered, and what it left for a machine that has more. */
function sayWhatThisCovers() {
  if (excluded === null || covered === null) {
    console.log(
      `[${project}] could not list the tagged cases, so this run does not say what it left out`,
    );
    return;
  }
  if (excluded.total === 0) {
    console.log(
      `[${project}] no case carries a scenario tag: this run covered all ${covered.total} of them`,
    );
    return;
  }
  const spelled = [...excluded.byTag]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, n]) => `${tag} ${n}`)
    .join(' · ');
  console.log(
    `[${project}] covered ${covered.total} of ${covered.total + excluded.total} cases; left out ${excluded.total} that need a service this machine may not have: ${spelled}`,
  );
  console.log(
    `[${project}] run them with \`pnpm ${ALL_SCRIPT}\`, or one service at a time with \`playwright test --project=${project} --grep "@needs-<service>"\``,
  );
}

const code = runPlaywright([
  'test',
  `--project=${project}`,
  `--grep-invert=${TAG_PREFIX}`,
  ...forwarded,
]);

// After the run, where the person reading the verdict is. The excluded cases
// have no line of their own in the report, so this is the only thing that says
// what the green covers, and it has to be next to the green.
sayWhatThisCovers();

process.exit(code);
