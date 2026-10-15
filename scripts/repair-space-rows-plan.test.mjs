// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { APPLY_SQL, staleContentRows, STALE_AFTER_MS } from "./repair-space-rows-plan.mjs";

const PID = "11111111-1111-4111-8111-111111111111";
const LISTED = "22222222-2222-4222-9222-222222222222";
const ORPHAN = "33333333-3333-4333-9333-333333333333";
const NOW = Date.parse("2026-10-15T12:00:00Z");
const LONG_AGO = new Date(NOW - 2 * 60 * 60 * 1000);
const JUST_NOW = new Date(NOW - 60 * 1000);

/** A content row as the script reads it. */
function row(name, updatedAt, deletedAt = null) {
  return { name, updatedAt, deletedAt };
}

test("lists a live row the meta does not list and nobody touched for over an hour", () => {
  const rows = [
    row(`project-${PID}/canvas-${LISTED}`, LONG_AGO),
    row(`project-${PID}/document-${ORPHAN}`, LONG_AGO),
  ];
  assert.deepEqual(staleContentRows({ metaSpaceIds: new Set([LISTED]), rows, now: NOW }), [
    `project-${PID}/document-${ORPHAN}`,
  ]);
});

test("leaves a row touched within the hour, such as one created or restored moments ago", () => {
  const rows = [row(`project-${PID}/canvas-${ORPHAN}`, JUST_NOW)];
  assert.deepEqual(staleContentRows({ metaSpaceIds: new Set(), rows, now: NOW }), []);
});

test("leaves rows that are already soft-deleted", () => {
  const rows = [row(`project-${PID}/canvas-${ORPHAN}`, LONG_AGO, LONG_AGO)];
  assert.deepEqual(staleContentRows({ metaSpaceIds: new Set(), rows, now: NOW }), []);
});

test("leaves the meta row itself", () => {
  const rows = [row(`project-${PID}/meta`, LONG_AGO)];
  assert.deepEqual(staleContentRows({ metaSpaceIds: new Set(), rows, now: NOW }), []);
});

test("waits an hour, well past the ten seconds a new Space waits for its meta to be stored", () => {
  assert.equal(STALE_AFTER_MS, 60 * 60 * 1000);
});

test("the apply statement checks both conditions again in the same statement", () => {
  assert.match(APPLY_SQL, /deleted_at IS NULL/);
  assert.match(APPLY_SQL, /updated_at < now\(\) - interval '1 hour'/);
});
