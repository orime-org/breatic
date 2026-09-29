// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { vi } from "vitest";

import type { ServiceCall, UsageRecorder } from "@domain/credit/usage-recorder.js";

/** A recorder that keeps what it was told, for a test to read back. */
export interface UsageSpy {
  recorder: UsageRecorder;
  serviceCalls: ServiceCall[];
}

/**
 * A fresh recorder spy.
 * @returns The recorder and the service calls it has been handed.
 */
export function usageSpy(): UsageSpy {
  const serviceCalls: ServiceCall[] = [];
  const recorder: UsageRecorder = {
    recordModelCall: vi.fn(),
    recordServiceCall: vi.fn((call: ServiceCall) => void serviceCalls.push(call)),
    recordLookedUpCall: vi.fn(),
    settle: vi.fn(async () => 0),
  };
  return { recorder, serviceCalls };
}

/**
 * The second argument the SDK hands a tool's `execute`.
 * @param extra - Fields a test adds, such as an abort signal.
 * @param usage - The recorder the turn passes in; a fresh spy when omitted.
 * @returns The options.
 */
export function toolOptions(
  extra: Record<string, unknown> = {},
  usage: UsageRecorder = usageSpy().recorder,
): Record<string, unknown> {
  return { toolCallId: "t1", messages: [], context: { usage }, ...extra };
}
