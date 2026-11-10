// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a container run used, as every container's report carries it: the
 * mini-tool jobs and the page reader (inner#1664) both bill from it.
 */
import { z } from "zod";

/** What the container measured about its own run. */
export interface ContainerUsage {
  /** From just before the container started until its run ended, cold start included. */
  wallMs: number;
  /** cgroup `cpu.stat` `usage_usec`; null when the container could not read it. */
  cpuUsec: number | null;
}

/** A container run's usage, as read off a report. */
export const containerUsageSchema: z.ZodType<ContainerUsage> = z.object({
  wallMs: z.number().nonnegative(),
  cpuUsec: z.number().nonnegative().nullable(),
});
