// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vitest globalSetup that gives the server's integration suite a trial grant.
 *
 * Runs before the shared container setup (`@breatic/integration-tests/containers`)
 * in `vitest.integration.config.ts`. Only this package's suites read these
 * files, so laying them down is the server's own step.
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The deployment config files these suites need, each with a fixture beside
 * this file. `credits.yaml` is not tracked by git: it is a deployment's own
 * trial grant. The suites that create accounts still need one, so a run that
 * finds none lays down the fixture.
 */
const DEPLOYMENT_CONFIGS = ["credits"] as const;

/** Repo root, from this file at packages/server/src/__tests__/integration/. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/** The configs this run laid down, and therefore the ones it may remove. */
const laidDown: string[] = [];

/**
 * Give the run a trial grant where the machine has none.
 *
 * Only writes what is absent, and records what it wrote, so a developer who
 * keeps their own `config/*.yaml` runs against theirs and still has it
 * afterwards.
 * @returns nothing; {@link laidDown} records what teardown must remove.
 */
export function setup(): void {
  for (const name of DEPLOYMENT_CONFIGS) {
    const target = resolve(REPO_ROOT, `config/${name}.yaml`);
    if (existsSync(target)) continue;
    copyFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), `fixtures/${name}.yaml`),
      target,
    );
    laidDown.push(target);
  }
  if (laidDown.length > 0) {
    console.log(`[integration] Laid down deployment config fixtures: ${laidDown.join(", ")}`);
  }
}

/**
 * Remove what this run laid down. A developer's own config was never touched
 * and is not in the list.
 * @returns nothing.
 */
export function teardown(): void {
  for (const path of laidDown) rmSync(path, { force: true });
}
