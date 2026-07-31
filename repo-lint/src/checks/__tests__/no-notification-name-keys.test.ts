// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { noNotificationNameKeys } from "#repo-lint/checks/no-notification-name-keys";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

const server = "packages/server/src/modules/notification/payload.ts";
const web = "packages/web/src/features/notifications/read.ts";

/**
 * A context holding both payload sites, one of them inert.
 *
 * Both, because the check refuses to run against a site that has gone
 * missing, and a fixture supplying one would be exercising the refusal
 * rather than the case it is written for.
 * @param files The files under test.
 * @returns A context over those files plus a quiet file at each site.
 */
function withBothSites(files: Record<string, string>) {
  return fakeContext({
    [`${server}.placeholder.ts`]: "const p = { studioId };",
    [`${web}.placeholder.ts`]: "const s = payload.studioId;",
    ...files,
  });
}

describe("no-notification-name-keys", () => {
  it("passes a payload that carries ids", () => {
    const context = withBothSites({ [server]: "const p = { studioId, fromUserId };" });
    expect(noNotificationNameKeys.run(context)).toEqual([]);
  });

  // The consumers are the half that cannot be typechecked, so losing sight of
  // them is the expensive direction. `files()` throws only when a selection
  // matches nothing at all, so with two sites folded into one selection the
  // check kept reporting clean while scanning half of what it names — and
  // moving a directory is an ordinary refactor, not an unlikely one.
  it("refuses to run when one of its two sites has moved", () => {
    const context = fakeContext({ [server]: "const p = { studioId };" });
    expect(() => noNotificationNameKeys.run(context)).toThrow(
      /packages\/web\/src\/features\/notifications/,
    );
  });

  it("refuses to run when the other site has moved", () => {
    const context = fakeContext({ [web]: "const s = payload.studioId;" });
    expect(() => noNotificationNameKeys.run(context)).toThrow(
      /packages\/server\/src\/modules\/notification/,
    );
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
    expect(noNotificationNameKeys.run(withBothSites(files))).toHaveLength(
      keys.length,
    );
  });

  it("ignores a key merely named in a comment", () => {
    const context = withBothSites({
      [server]: "// fromHandle used to live here\nconst p = {};",
    });
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
    const context = withBothSites({
      "packages/web/src/pages/project/route.ts": "const { projectSlug } = params;",
      [server]: "const p = { studioId };",
    });
    expect(noNotificationNameKeys.run(context)).toEqual([]);
  });

  it("names the file and line", () => {
    const context = withBothSites({
      [server]: "one\ntwo\nconst p = { fromHandle };",
    });
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
