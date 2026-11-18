// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a pickup throws when the work it started is not finished
 * (inner#1337 §3.1). The running-task gate throws the same class
 * (inner#1968), so the worker answers both with one catch.
 */
export { StillRunning } from "@breatic/domain/still-running";
