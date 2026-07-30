// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { noNotificationNameKeys } from "#repo-lint/checks/no-notification-name-keys";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

const server = "packages/server/src/modules/notification/payload.ts";
const web = "packages/web/src/features/notifications/read.ts";

describe("no-notification-name-keys", () => {
  it("passes a payload that carries ids", () => {
    const context = fakeContext({ [server]: "const p = { studioId, fromUserId };" });
    expect(noNotificationNameKeys.run(context)).toEqual([]);
  });

  it("catches a frozen handle and a frozen slug", () => {
    const context = fakeContext({
      [server]: "const p = { fromHandle };",
      [web]: 'const s = str(payload, "studioSlug");',
    });
    expect(noNotificationNameKeys.run(context)).toHaveLength(2);
  });

  it("catches every banned key", () => {
    const keys = [
      "requesterHandle", "deciderHandle", "inviterHandle", "inviteeHandle",
      "fromHandle", "accepterHandle", "projectSlug", "studioSlug",
    ];
    const files = Object.fromEntries(
      keys.map((key, index) => [`${server.replace(".ts", "")}${index}.ts`, `const p = { ${key} };`]),
    );
    expect(noNotificationNameKeys.run(fakeContext(files))).toHaveLength(keys.length);
  });

  it("ignores a key merely named in a comment", () => {
    const context = fakeContext({ [server]: "// fromHandle used to live here\nconst p = {};" });
    expect(noNotificationNameKeys.run(context)).toEqual([]);
  });

  it("honours the deliberate escape and a test asserting absence", () => {
    const context = fakeContext({
      [server]: "const p = { studioSlug }; // allow-notification-name-key: redirect target",
      [web]: 'expect(payload).not.toHaveProperty("fromHandle");',
    });
    expect(noNotificationNameKeys.run(context)).toEqual([]);
  });

  it("leaves the same key alone outside notification code", () => {
    // projectSlug is a perfectly good name in a route or on the canvas.
    const context = fakeContext({
      "packages/web/src/pages/project/route.ts": "const { projectSlug } = params;",
      [server]: "const p = { studioId };",
    });
    expect(noNotificationNameKeys.run(context)).toEqual([]);
  });

  it("names the file and line", () => {
    const context = fakeContext({ [server]: "one\ntwo\nconst p = { fromHandle };" });
    const findings = noNotificationNameKeys.run(context);
    expect(findings[0]?.file).toBe(server);
    expect(findings[0]?.line).toBe(3);
  });

  it("fails rather than reports clean when it selects no files", () => {
    expect(() => noNotificationNameKeys.run(fakeContext({ "a.ts": "x" }))).toThrow(
      /matched none/,
    );
  });
});
