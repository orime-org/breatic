// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Application environment. */
export const Environment = {
  DEV: "dev",
  STAGING: "staging",
  PROD: "prod",
} as const;

/** Application environment type. */
export type Environment = (typeof Environment)[keyof typeof Environment];

/** Task execution status. */
export const TaskStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

/** Task execution status type. */
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export { DEFAULT_API_PORT, DEFAULT_COLLAB_PORT } from "@shared/constants/ports.js";
export { AVATAR_OUTPUT_PX } from "@shared/constants/avatar.js";
