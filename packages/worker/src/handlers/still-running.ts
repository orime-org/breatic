// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a pickup throws when the work it started is not finished
 * (inner#1337 §3.1). The running-task gate throws the same class
 * (inner#1968); each place that catches it (the gate and the upstream wait in
 * `dispatch.ts`, and `runTimelineExecution`) moves the job back to the
 * delayed queue.
 */
export { StillRunning } from "@breatic/domain/still-running";
