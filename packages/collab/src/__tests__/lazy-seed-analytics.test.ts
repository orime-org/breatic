// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The project's automatic first Space is reported as created by whoever
 * opened the project, under that browser's consent cookie (inner#1442 design
 * §4.4.5, §4.8).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { seedInitialStateMock, reportSpaceCreatedMock, getSessionMock, consentSeen } = vi.hoisted(() => ({
  seedInitialStateMock: vi.fn(),
  reportSpaceCreatedMock: vi.fn(),
  getSessionMock: vi.fn(),
  consentSeen: [] as unknown[],
}));

vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  seedInitialState: seedInitialStateMock,
  fetchDocData: vi.fn(),
}));

vi.mock("@collab/services/space-analytics.js", () => ({
  reportSpaceCreated: reportSpaceCreatedMock,
}));

vi.mock("@breatic/core", async (importActual: () => Promise<Record<string, unknown>>) => ({
  ...(await importActual()),
  loadInitialSpaceType: vi.fn(async () => "canvas"),
  projectActivitiesRepo: { insert: vi.fn() },
  serverAnalyticsOn: () => true,
  getRedis: () => ({}),
  getSession: getSessionMock,
  sessionCookieName: () => "session",
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { currentConsent } from "@breatic/core";
import { CONSENT_COOKIE_NAME, CONSENT_REVISION, deriveId, projectMetaDocName } from "@breatic/shared";
import { lazySeedMeta } from "../services/lazy-seed.js";

const PID = "11111111-1111-4111-8111-111111111111";

/**
 * Headers of a WebSocket upgrade carrying the given cookies.
 * @param cookies - Cookie name to value.
 * @returns The headers.
 */
function upgrade(cookies: Record<string, string>): Headers {
  return new Headers({
    cookie: Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("; "),
  });
}

const ACCEPTED = JSON.stringify({
  categories: ["necessary", "analytics"],
  revision: CONSENT_REVISION,
  data: { analytics: { decidedAt: new Date().toISOString(), source: "banner" } },
});

beforeEach(() => {
  vi.clearAllMocks();
  consentSeen.splice(0);
  seedInitialStateMock.mockResolvedValue(true);
  reportSpaceCreatedMock.mockImplementation(async () => void consentSeen.push(currentConsent()));
});

describe("lazySeedMeta analytics", () => {
  it("reports the seeded Space as the opener's, under the opener's consent", async () => {
    await lazySeedMeta(projectMetaDocName(PID), {
      requestHeaders: upgrade({ [CONSENT_COOKIE_NAME]: ACCEPTED }),
      context: { user: { id: "user-12345" } },
    });
    expect(reportSpaceCreatedMock).toHaveBeenCalledWith({
      projectId: PID,
      spaceId: deriveId(PID),
      spaceType: "canvas",
      userId: "user-12345",
      via: "seed",
    });
    expect(consentSeen).toEqual([{ analytics: true, ads: false }]);
  });

  it("reads the opener from the session cookie when the load carried no user", async () => {
    getSessionMock.mockResolvedValue("user-from-session");
    await lazySeedMeta(projectMetaDocName(PID), {
      requestHeaders: upgrade({ [CONSENT_COOKIE_NAME]: ACCEPTED, session: "tok" }),
      context: {},
    });
    expect(getSessionMock).toHaveBeenCalledWith({}, "tok");
    expect(reportSpaceCreatedMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-from-session" }));
  });

  it("reports nothing without analytics consent", async () => {
    await lazySeedMeta(projectMetaDocName(PID), {
      requestHeaders: upgrade({}),
      context: { user: { id: "user-12345" } },
    });
    expect(reportSpaceCreatedMock).not.toHaveBeenCalled();
  });

  it("still loads the project when the consent cookie cannot be decoded", async () => {
    await expect(
      lazySeedMeta(projectMetaDocName(PID), {
        requestHeaders: new Headers({ cookie: `${CONSENT_COOKIE_NAME}=%` }),
        context: { user: { id: "user-12345" } },
      }),
    ).resolves.toBeDefined();
    expect(reportSpaceCreatedMock).not.toHaveBeenCalled();
  });

  it("reports nothing for a loader that lost the seed race", async () => {
    seedInitialStateMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await lazySeedMeta(projectMetaDocName(PID), {
      requestHeaders: upgrade({ [CONSENT_COOKIE_NAME]: ACCEPTED }),
      context: { user: { id: "user-12345" } },
    });
    expect(reportSpaceCreatedMock).not.toHaveBeenCalled();
  });
});
