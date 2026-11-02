// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A document name whose project part is not a uuid, through the real auth
 * hook, the real session store and the real project role lookup on Postgres
 * (inner#1139). Only the logger is replaced, so the test can read what the
 * hook wrote; the role lookup must stay real, or a database error on the
 * malformed id would never happen here.
 */

import crypto from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type * as CoreModule from "@breatic/core";

const { loggerWarn, loggerError } = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  createLogger: () => ({
    warn: loggerWarn,
    error: loggerError,
    info: vi.fn(),
    debug: vi.fn(),
    child: () => ({ warn: loggerWarn, error: loggerError, info: vi.fn(), debug: vi.fn() }),
  }),
}));

import { initCore, getRedis, rawPg as sql, sessionCookieName, setSession } from "@breatic/core";
import { createAuthHook } from "@collab/hooks/auth.js";
import type { DocumentRegistry } from "@collab/services/project-space-list.js";

let userId: string;
let projectId: string;
let cookie: string;

beforeAll(async () => {
  initCore(process.env);
  const tag = `shape-${crypto.randomBytes(4).toString("hex")}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${tag}, 'personal', ${tag}) RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${userId}, ${tag}, ${tag}) RETURNING id
  `;
  projectId = project!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, 'editor', null)
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  cookie = `${sessionCookieName()}=${token}`;
});

beforeEach(() => {
  loggerWarn.mockClear();
  loggerError.mockClear();
});

/**
 * Run the auth hook once for a document name, as the signed-in user.
 * @param documentName - The document the client asked for
 * @returns The settled outcome of the hook
 */
async function authenticate(documentName: string): Promise<PromiseSettledResult<unknown>> {
  const hook = createAuthHook({
    redis: getRedis(),
    resolveConnectionLimit: async () => 10,
    countConnections: async () => 0,
    hasOwnSeat: async () => "no" as const,
  });
  const [outcome] = await Promise.allSettled([
    hook({
      token: "__cookie_auth__",
      documentName,
      requestHeaders: new Headers({ cookie }),
      connectionConfig: { readOnly: false },
      instance: {} as DocumentRegistry,
      request: new Request("http://localhost"),
      socketId: "shape-test",
    }),
  ]);
  return outcome;
}

describe("a document name whose project part is not a uuid (inner#1139)", () => {
  for (const documentName of ["project-not-a-uuid/meta", "project-not-a-uuid/canvas-s1"]) {
    it(`L1/L2 ${documentName} is refused as not a member, with no error logged`, async () => {
      const outcome = await authenticate(documentName);
      expect(outcome.status).toBe("rejected");
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        { userId, documentName, projectId: "not-a-uuid", reason: "not_member" },
        "auth_rejected",
      );
      expect(loggerError).not.toHaveBeenCalled();
    });
  }

  it("L3 an upper-case uuid of the member's project is still let in", async () => {
    const outcome = await authenticate(`project-${projectId.toUpperCase()}/meta`);
    expect(outcome.status).toBe("fulfilled");
    expect(loggerWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "not_member" }),
      "auth_rejected",
    );
    expect(loggerError).not.toHaveBeenCalled();
  });
});
