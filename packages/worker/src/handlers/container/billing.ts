// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one container run cost (inner#888 §9): memory and disk for the wall
 * time Cloudflare bills the instance for, and CPU for the time the container
 * measured itself using. A pure function of the job's report, so every
 * attempt that reads the same report charges the same number.
 */

import type { ContainerUsage } from "@breatic/shared";

/** The size of the instance type a container class runs on. */
export interface ContainerSize {
  vcpu: number;
  memory_gib: number;
  disk_gb: number;
}

/** Published per-second prices. */
export interface ContainerPrices {
  vcpu_second_usd: number;
  memory_gib_second_usd: number;
  disk_gb_second_usd: number;
}

/**
 * The cost of one run in USD. Without a CPU reading the class's full vCPU is
 * billed for the wall time, which is the most the instance can have used.
 * @param usage - The run's report.
 * @param size - The class's instance size.
 * @param prices - The published prices.
 * @returns The cost in USD.
 */
export function containerCostUsd(usage: ContainerUsage, size: ContainerSize, prices: ContainerPrices): number {
  const wallSeconds = usage.wallMs / 1000;
  const cpuSeconds = usage.cpuUsec === null ? wallSeconds * size.vcpu : usage.cpuUsec / 1_000_000;
  return (
    wallSeconds * (size.memory_gib * prices.memory_gib_second_usd + size.disk_gb * prices.disk_gb_second_usd) +
    cpuSeconds * prices.vcpu_second_usd
  );
}
