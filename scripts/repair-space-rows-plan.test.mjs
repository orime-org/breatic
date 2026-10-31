// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { repairProject, staleContentRows } from "./repair-space-rows-plan.mjs";

const PID = "11111111-1111-4111-8111-111111111111";
const LISTED = "22222222-2222-4222-9222-222222222222";
const ORPHAN = "33333333-3333-4333-9333-333333333333";
const NOW = Date.parse("2026-10-15T12:00:00Z");
const LONG_AGO = new Date(NOW - 2 * 60 * 60 * 1000);
const JUST_NOW = new Date(NOW - 60 * 1000);
const LISTED_CANVAS = `project-${PID}/canvas-${LISTED}`;

/** A content row as the script reads it. */
function row(name, updatedAt, deletedAt = null) {
  return { name, updatedAt, deletedAt };
}

test("lists a live row the meta does not list and nobody touched for over an hour", () => {
  const rows = [row(LISTED_CANVAS, LONG_AGO), row(`project-${PID}/document-${ORPHAN}`, LONG_AGO)];
  assert.deepEqual(staleContentRows({ listedNames: new Set([LISTED_CANVAS]), rows, now: NOW }), [
    `project-${PID}/document-${ORPHAN}`,
  ]);
});

test("lists a row of another kind under a listed Space's id", () => {
  const rows = [row(LISTED_CANVAS, LONG_AGO), row(`project-${PID}/document-${LISTED}`, LONG_AGO)];
  assert.deepEqual(staleContentRows({ listedNames: new Set([LISTED_CANVAS]), rows, now: NOW }), [
    `project-${PID}/document-${LISTED}`,
  ]);
});

test("leaves a row touched within the hour, such as one created or restored moments ago", () => {
  const rows = [row(`project-${PID}/canvas-${ORPHAN}`, JUST_NOW)];
  assert.deepEqual(staleContentRows({ listedNames: new Set(), rows, now: NOW }), []);
});

test("leaves rows that are already soft-deleted", () => {
  const rows = [row(`project-${PID}/canvas-${ORPHAN}`, LONG_AGO, LONG_AGO)];
  assert.deepEqual(staleContentRows({ listedNames: new Set(), rows, now: NOW }), []);
});

test("writes nothing without --apply", async () => {
  const deleted = [];
  const result = await repairProject({
    listedNames: new Set(),
    rows: [row(`project-${PID}/canvas-${ORPHAN}`, LONG_AGO)],
    now: NOW,
    apply: false,
    softDelete: async (name) => {
      deleted.push(name);
      return 1;
    },
  });
  assert.deepEqual(deleted, []);
  assert.deepEqual(result, { stale: [`project-${PID}/canvas-${ORPHAN}`], softDeleted: [], leftAlone: [] });
});

test("reports a row the apply statement no longer matched as left alone", async () => {
  const stale = `project-${PID}/canvas-${ORPHAN}`;
  const restored = `project-${PID}/document-${ORPHAN}`;
  const result = await repairProject({
    listedNames: new Set(),
    rows: [row(stale, LONG_AGO), row(restored, LONG_AGO)],
    now: NOW,
    apply: true,
    softDelete: async (name) => (name === restored ? 0 : 1),
  });
  assert.deepEqual(result, { stale: [stale, restored], softDeleted: [stale], leftAlone: [restored] });
});
