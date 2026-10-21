// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The `connected` hook reads the role and the session once more, last.
 *
 * Both reads exist for a change that committed between a connection's
 * handshake and its registration: the change's own kick ran before this
 * connection could be found. Each read has its own unit tests; this pins that
 * the hook still calls them, after the connection is registered.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../hocuspocus.ts"), "utf-8");
const code = source
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
  .join("\n");

describe("connected hook", () => {
  it("re-reads the role and then the session after registering the connection", () => {
    const hook = code.indexOf("connected: async (");
    const registered = code.indexOf("liveConnections.remember(", hook);
    const role = code.indexOf("recheckRoleOnConnect(", hook);
    const session = code.indexOf("closeIfSessionEnded(connection,", hook);
    const next = code.indexOf("beforeHandleAwareness:", hook);

    expect(hook).toBeGreaterThanOrEqual(0);
    expect(registered).toBeGreaterThan(hook);
    expect(role).toBeGreaterThan(registered);
    expect(session).toBeGreaterThan(role);
    expect(session).toBeLessThan(next);
  });
});
