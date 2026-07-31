// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Where notification payloads are defined and read.
 *
 * Deliberately narrow. `projectSlug` is a perfectly good name elsewhere —
 * project routes, the canvas — and this is about stored notification
 * payloads only. The producers pass a typed payload, so re-adding a key
 * there is a compile error and needs no scan; the consumers read by string
 * key out of an opaque record, and that is the hole this covers.
 */
const PAYLOAD_SITES = [
  "packages/server/src/modules/notification/",
  "packages/web/src/features/notifications/",
];

/** Keys that freeze a display name or a slug into a stored record. */
const NAME_SHAPED = new RegExp(
  [
    "requesterHandle",
    "deciderHandle",
    "inviterHandle",
    "inviteeHandle",
    "fromHandle",
    "accepterHandle",
    "projectSlug",
    "studioSlug",
  ].join("|"),
);

/** A line deliberately kept, or a test asserting the key is absent. */
const PERMITTED = /not\.toHaveProperty|allow-notification-name-key/;

/** A whole-line comment, which names a key rather than carrying one. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

/**
 * Notification payloads carry ids, never names or slugs.
 *
 * A stored slug is a snapshot. Renaming a studio releases the old slug for
 * anyone to claim, and a personal studio's slug is its owner's handle — so
 * an old notification ends up naming and linking to a stranger, with
 * nothing in the stored string to reveal it. The fix, already in place, is
 * to store the id and resolve display identity at read time.
 *
 * The type checker cannot hold this: the consumers read these payloads by
 * string key out of an opaque record, so re-introducing one compiles
 * cleanly and fails only at runtime, silently, as a missing name or a dead
 * link.
 *
 * The invite landing services are out of scope on purpose. They return a
 * slug for a post-confirm redirect, which is a live lookup answering
 * "where do I send this person now" rather than a name frozen into a
 * stored record — the opposite of what this is about.
 */
export const noNotificationNameKeys = {
  name: "no-notification-name-keys",
  description: "Notification payloads carry ids, not names or slugs",
  run(context: CheckContext): Finding[] {
    // One selection per site, not one selection over both. A selection throws
    // when it matches nothing, so folding two sites together meant a site
    // that had moved took the other one's word for it: the scan covered half
    // of what it names and reported clean. Moving a directory is an ordinary
    // refactor, and the consumers — the half no type checker can hold — are
    // the expensive half to stop looking at.
    const files = PAYLOAD_SITES.flatMap((site) =>
      context.files((path) => path.startsWith(site), `files under ${site}`),
    );

    const findings: Finding[] = [];
    for (const file of files) {
      context
        .read(file)
        .split("\n")
        .forEach((line, index) => {
          if (!NAME_SHAPED.test(line)) return;
          if (COMMENT_LINE.test(line) || PERMITTED.test(line)) return;
          findings.push({
            file,
            line: index + 1,
            message: `${(NAME_SHAPED.exec(line) ?? [""])[0]} freezes a display name into a stored payload. A slug can be released and reclaimed by someone else, so an old notification would name and link to a stranger — store the id and resolve the name when the notification is read.`,
          });
        });
    }
    return findings;
  },
} satisfies Check;
