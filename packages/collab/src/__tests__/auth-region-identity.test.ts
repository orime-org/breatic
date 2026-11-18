// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Document authentication in a region that does not hold the global data
 * (inner#1955). One tab shares one WebSocket for all its documents, and every
 * document is authenticated with the headers of that one upgrade request, so
 * an identity token checked once at the upgrade has long expired by the time
 * a later Space opens. The hook therefore takes who the connection is from
 * the identity the upgrade gate bound to it, checks only the revocation
 * tombstone, and never reads a session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type { Redis } from "@breatic/core";
import * as Y from "yjs";

const { getSessionMock, loadProjectRoleMock, revokedMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  loadProjectRoleMock: vi.fn(),
  revokedMock: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  listedContentDocNames: (await importOriginal<typeof CoreModule>()).listedContentDocNames,
  sessionId: (await importOriginal<typeof CoreModule>()).sessionId,
  env: { ALLOWED_ORIGINS: "https://app.example.com" },
  getSession: getSessionMock,
  isIdentityRevoked: revokedMock,
  projectAuthService: { loadProjectRole: loadProjectRoleMock },
  sessionCookieName: () => "breatic_session",
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { createAuthHook } from "@collab/hooks/auth.js";

const REDIS = {} as unknown as Redis;
const PID = "11111111-1111-4111-8111-111111111111";
const SPACE = "22222222-2222-4222-9222-222222222222";
const USER = "44444444-4444-4444-8444-444444444444";
const SID = "c".repeat(64);

/**
 * A meta doc listing one canvas Space.
 * @returns The doc.
 */
function metaWithSpace(): Y.Doc {
  const doc = new Y.Doc();
  const entry = new Y.Map();
  doc.getMap("spaces").set(SPACE, entry);
  entry.set("id", SPACE);
  entry.set("type", "canvas");
  return doc;
}

/**
 * The hook as a non-global region builds it, wrapped with the fixed arguments.
 * @param bound - The identity the upgrade gate bound to this connection.
 * @returns A call that authenticates one document on that connection.
 */
function regionHook(
  bound: { userId: string; sid: string } | undefined,
  requestHeaders: Headers = new Headers(),
): (documentName: string) => Promise<unknown> {
  const hook = createAuthHook({
    redis: REDIS,
    resolveConnectionLimit: async () => 100,
    countConnections: async () => 0,
    hasOwnSeat: async () => "no" as const,
    boundIdentity: () => bound,
  });
  const instance = {
    documents: new Map<string, Y.Doc>([[`project-${PID}/meta`, metaWithSpace()]]),
    createDocument: vi.fn(async () => new Y.Doc()),
    unloadDocument: vi.fn(async () => undefined),
  };
  return (documentName) =>
    hook({
      token: "__cookie_auth__",
      documentName,
      requestHeaders,
      connectionConfig: { readOnly: false },
      instance,
      request: new Request("http://localhost/"),
      socketId: "socket-1",
    });
}

beforeEach(() => {
  getSessionMock.mockReset();
  loadProjectRoleMock.mockReset();
  loadProjectRoleMock.mockResolvedValue("editor");
  revokedMock.mockReset();
  revokedMock.mockResolvedValue(false);
});

describe("document authentication with a bound identity", () => {
  it("authenticates the bound user without reading a session or a cookie", async () => {
    const authenticate = regionHook({ userId: USER, sid: SID });

    const ctx = await authenticate(`project-${PID}/canvas-${SPACE}`);

    expect(ctx).toMatchObject({ user: { id: USER, role: "editor" }, session: { id: SID } });
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(loadProjectRoleMock).toHaveBeenCalledWith(USER, PID);
  });

  it("authenticates every later document on the same connection the same way", async () => {
    const authenticate = regionHook({ userId: USER, sid: SID });

    await authenticate(`project-${PID}/meta`);
    const later = await authenticate(`project-${PID}/canvas-${SPACE}`);

    expect(later).toMatchObject({ user: { id: USER } });
    expect(revokedMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a connection the upgrade gate bound no identity to, even with a session cookie", async () => {
    getSessionMock.mockResolvedValue(USER);
    const authenticate = regionHook(undefined, new Headers({ cookie: "breatic_session=tok" }));

    await expect(authenticate(`project-${PID}/canvas-${SPACE}`)).rejects.toThrow();
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(loadProjectRoleMock).not.toHaveBeenCalled();
  });

  it("refuses a document once the bound session has a revocation tombstone", async () => {
    revokedMock.mockResolvedValue(true);
    const authenticate = regionHook({ userId: USER, sid: SID });

    await expect(authenticate(`project-${PID}/canvas-${SPACE}`)).rejects.toThrow();
    expect(revokedMock).toHaveBeenCalledWith(REDIS, SID);
    expect(loadProjectRoleMock).not.toHaveBeenCalled();
  });
});
