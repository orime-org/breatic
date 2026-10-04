// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A connection whose handshake read the role just before a change committed
 * registers after the change's kick has already run, so the kick never sees
 * it. Re-reading the role once the connection is registered closes that gap:
 * either the kick reaches the connection, or the connection reads the new role.
 */

import { describe, it, expect, vi } from "vitest";
import type { ProjectRole } from "@breatic/shared";

import { recheckRoleOnConnect } from "@collab/services/role-recheck.js";

const PID = "11111111-1111-4111-8111-111111111111";
const DOC = `project-${PID}/canvas-22222222-2222-4222-9222-222222222222`;

function setup(granted: ProjectRole, now: ProjectRole | null) {
  const close = vi.fn();
  const loadRole = vi.fn(async () => now);
  return {
    close,
    loadRole,
    run: () =>
      recheckRoleOnConnect(
        { documentName: DOC, userId: "u1", grantedRole: granted, connection: { close } },
        loadRole,
      ),
  };
}

describe("recheckRoleOnConnect", () => {
  it("closes a connection granted editor on a project that is now read-only to them", async () => {
    const { close, loadRole, run } = setup("editor", "viewer");
    await run();
    expect(loadRole).toHaveBeenCalledWith("u1", PID);
    expect(close).toHaveBeenCalledWith({ code: 4403, reason: "Permission changed, please reconnect" });
  });

  it("closes a connection granted viewer on a project they may now write", async () => {
    const { close, run } = setup("viewer", "editor");
    await run();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a connection whose member has gone", async () => {
    const { close, run } = setup("editor", null);
    await run();
    expect(close).toHaveBeenCalledOnce();
  });

  it("leaves a connection alone when the role still matches", async () => {
    const { close, run } = setup("owner", "owner");
    await run();
    expect(close).not.toHaveBeenCalled();
  });

  it("leaves a document outside any project alone", async () => {
    const close = vi.fn();
    const loadRole = vi.fn();
    await recheckRoleOnConnect(
      { documentName: "not-a-project-doc", userId: "u1", grantedRole: "owner", connection: { close } },
      loadRole,
    );
    expect(loadRole).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
