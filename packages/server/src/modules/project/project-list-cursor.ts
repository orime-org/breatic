// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The studio project list's keyset cursor and the name collation it pages by.
 *
 * A cursor is the sort values of the last row a page returned. Times travel
 * as whole microseconds since the epoch, so they keep the precision Postgres
 * stores: a `Date` would round them to milliseconds and rows inside the same
 * millisecond would be skipped at a page boundary.
 */

import { z } from "zod";
import type { StudioProjectSort } from "@breatic/shared";

/** The ICU collations a name sort may use, by interface language. */
const NAME_COLLATIONS = {
  "zh-CN": "zh-Hans-x-icu",
  "zh-TW": "zh-Hant-x-icu",
  ja: "ja-x-icu",
  ko: "ko-x-icu",
} as const satisfies Record<string, string>;

/** The collation for every other language. */
const DEFAULT_NAME_COLLATION = "und-x-icu";

/** One of the collations above; only these names ever reach SQL. */
export type NameCollation =
  | (typeof NAME_COLLATIONS)[keyof typeof NAME_COLLATIONS]
  | typeof DEFAULT_NAME_COLLATION;

/**
 * The collation a reader's names are sorted by.
 * @param locale - The reader's interface language.
 * @returns The ICU collation for that language.
 */
export function nameCollationFor(locale: string): NameCollation {
  return Object.hasOwn(NAME_COLLATIONS, locale)
    ? NAME_COLLATIONS[locale as keyof typeof NAME_COLLATIONS]
    : DEFAULT_NAME_COLLATION;
}

/**
 * A time as whole microseconds since the Unix epoch, in decimal. Sixteen
 * digits reach past the year 2286, well inside what Postgres timestamps hold,
 * so any value that passes converts without error and at full precision.
 */
const epochMicros = z.string().regex(/^-?\d{1,16}$/);

const cursorSchema = z.discriminatedUnion("s", [
  z.object({
    s: z.literal("opened"),
    openedAt: epochMicros.nullable(),
    createdAt: epochMicros,
    id: z.uuid(),
  }),
  z.object({ s: z.literal("edited"), editedAt: epochMicros, id: z.uuid() }),
  z.object({
    s: z.literal("name"),
    collation: z.string(),
    // Postgres text cannot hold NUL.
    name: z.string().refine((v) => !v.includes("\u0000")),
    id: z.uuid(),
  }),
  z.object({ s: z.literal("created"), createdAt: epochMicros, id: z.uuid() }),
  z.object({ s: z.literal("archived"), archivedAt: epochMicros, id: z.uuid() }),
]);

/** Where the previous page stopped, for one sort. */
export type ProjectListCursor = z.infer<typeof cursorSchema>;

/**
 * Encode a cursor for the wire.
 * @param cursor - The last row's sort values.
 * @returns An opaque base64url string.
 */
export function encodeProjectListCursor(cursor: ProjectListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/**
 * Read a cursor from the wire, for the list it is being used with.
 *
 * A cursor that does not parse, holds a value the database could not take,
 * belongs to another sort, or was made under another name collation reads as
 * none: the list starts again from its first page. It comes from the network,
 * so a bad one must not fail the request.
 * @param raw - The opaque string, if any.
 * @param sort - The sort the page is asked for in.
 * @param collation - The name collation of this request.
 * @returns The cursor, or null to start from the first page.
 */
export function decodeProjectListCursor(
  raw: string | undefined,
  sort: StudioProjectSort,
  collation: NameCollation,
): ProjectListCursor | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = cursorSchema.safeParse(json);
  if (!parsed.success || parsed.data.s !== sort) return null;
  if (parsed.data.s === "name" && parsed.data.collation !== collation) return null;
  return parsed.data;
}
