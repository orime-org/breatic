// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The studio project list's sorts and pages against a real Postgres (inner#1020).
 *
 * Paging is a keyset over each sort, so the property that matters is that
 * walking every page in order yields each project exactly once, in the sort's
 * order, including where sort values tie and where the viewer never opened a
 * project. The data below is built to hit both.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import postgres from "postgres";
import { ConflictError, initCore } from "@breatic/core";
import type { StudioProjectSort } from "@breatic/shared";
import * as projectService from "@server/modules/project/project.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "studio-project-list-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Insert a user.
 * @returns The user id.
 */
async function insertUser(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`spl-${seq++}@example.com`}, true) RETURNING id
  `;
  return row!.id;
}

/**
 * Insert a team studio with `admin` as its admin.
 * @param admin - The admin user.
 * @returns The studio id.
 */
async function insertStudio(admin: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${admin}, ${`spl-studio-${seq++}`}, 'team', 'Studio') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${row!.id}, ${admin}, 'admin')`;
  return row!.id;
}

/**
 * Insert a project owned by `owner`.
 * @param studioId - Its studio.
 * @param owner - Its owner.
 * @param name - Its name.
 * @param createdAt - Its creation time.
 * @returns The project id.
 */
async function insertProject(
  studioId: string,
  owner: string,
  name: string,
  createdAt: string,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, created_at)
    VALUES (${studioId}, ${owner}, ${name}, ${`spl-project-${seq++}`}, ${createdAt}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${row!.id}, ${owner}, 'owner', null)
  `;
  return row!.id;
}

/** One studio of 120 projects with tied creation, open and edit times. */
interface Fixture {
  studioId: string;
  admin: string;
  ids: string[];
}

let fixture: Fixture | undefined;

/**
 * Build the shared 120-project studio once.
 * @returns The fixture.
 */
async function bigStudio(): Promise<Fixture> {
  if (fixture) return fixture;
  const admin = await insertUser();
  const studioId = await insertStudio(admin);
  const ids: string[] = [];
  for (let i = 0; i < 120; i += 1) {
    // Ten projects share each creation time, and names repeat every 30.
    const createdAt = `2026-01-${String(1 + Math.floor(i / 10)).padStart(2, "0")}T00:00:00Z`;
    const name = ["apple", "Banana", "Zoo", "城市", "海报", "alpha"][i % 6]! + ` ${i % 30}`;
    ids.push(await insertProject(studioId, admin, name, createdAt));
  }
  // The admin opened two thirds of them, in pairs that share a time; the rest
  // were never opened.
  for (let i = 0; i < 80; i += 1) {
    await sql`
      INSERT INTO project_last_opened (user_id, project_id, last_opened_at)
      VALUES (${admin}, ${ids[i]!}, ${`2026-05-01T00:00:${String(Math.floor(i / 2) % 60).padStart(2, "0")}Z`})
    `;
  }
  // Half of them were edited, several at the same moment.
  for (let i = 0; i < 120; i += 2) {
    await sql`
      INSERT INTO project_edits (project_id, last_edited_at)
      VALUES (${ids[i]!}, ${`2026-06-01T00:00:${String(Math.floor(i / 6) % 60).padStart(2, "0")}Z`})
    `;
  }
  fixture = { studioId, admin, ids };
  return fixture;
}

/**
 * Walk every page of one list.
 * @param studioId - The studio.
 * @param viewer - Who is looking.
 * @param archived - Which list.
 * @param sort - The sort.
 * @param locale - The reader's interface language.
 * @returns Every id in the order the pages returned them, and the totals seen.
 */
async function walk(
  studioId: string,
  viewer: string,
  archived: boolean,
  sort: StudioProjectSort,
  locale = "en",
): Promise<{ ids: string[]; totals: Array<number | null> }> {
  const ids: string[] = [];
  const totals: Array<number | null> = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await projectService.listByStudioForViewer(studioId, viewer, {
      archived,
      sort,
      cursor,
      limit: 50,
      locale,
    });
    ids.push(...page.items.map((p) => p.id));
    totals.push(page.total);
    if (page.nextCursor === null) return { ids, totals };
    cursor = page.nextCursor;
  }
  throw new Error("paging did not end");
}

/**
 * The whole list in one query, in the order the sort promises.
 * @param studioId - The studio.
 * @param viewer - Whose opens count.
 * @param orderBy - The ORDER BY the sort stands for.
 * @returns Every live project id in that order.
 */
async function expected(studioId: string, viewer: string, orderBy: string): Promise<string[]> {
  const rows = await sql.unsafe<{ id: string }[]>(
    `SELECT p.id FROM projects p
       LEFT JOIN project_last_opened lo ON lo.project_id = p.id AND lo.user_id = $2
       LEFT JOIN project_edits pe ON pe.project_id = p.id
     WHERE p.studio_id = $1 AND p.deleted_at IS NULL AND p.archived_at IS NULL
     ORDER BY ${orderBy}`,
    [studioId, viewer],
  );
  return rows.map((r) => r.id);
}

describe("studio project list — every page together is the sorted list, once each", () => {
  const cases: Array<[StudioProjectSort, string, string]> = [
    ["opened", "en", "(lo.last_opened_at IS NULL), lo.last_opened_at DESC, p.created_at DESC, p.id DESC"],
    ["edited", "en", "COALESCE(pe.last_edited_at, p.created_at) DESC, p.id DESC"],
    ["created", "en", "p.created_at DESC, p.id DESC"],
    ["name", "en", `p.name COLLATE "und-x-icu", p.id`],
    ["name", "zh-CN", `p.name COLLATE "zh-Hans-x-icu", p.id`],
  ];

  for (const [sort, locale, orderBy] of cases) {
    it(`sort=${sort} locale=${locale}`, async () => {
      const f = await bigStudio();
      const { ids, totals } = await walk(f.studioId, f.admin, false, sort, locale);

      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(await expected(f.studioId, f.admin, orderBy));
      // Counted once, on the first page.
      expect(totals).toEqual([120, null, null]);
    });
  }

  it("puts projects the viewer never opened after the opened ones", async () => {
    const f = await bigStudio();
    const { ids } = await walk(f.studioId, f.admin, false, "opened");
    const neverOpened = new Set(f.ids.slice(80));
    expect(ids.slice(80).every((id) => neverOpened.has(id))).toBe(true);
  });

  it("sorts names case-insensitively for an English reader", async () => {
    const f = await bigStudio();
    const page = await projectService.listByStudioForViewer(f.studioId, f.admin, {
      archived: false,
      sort: "name",
      limit: 100,
      locale: "en",
    });
    const firstLetters = page.items.map((p) => p.name[0]);
    expect(firstLetters.indexOf("Z")).toBeGreaterThan(firstLetters.lastIndexOf("a"));
  });

  it("carries the viewer's open time and the edit time on each row", async () => {
    const f = await bigStudio();
    const first = await projectService.listByStudioForViewer(f.studioId, f.admin, {
      archived: false,
      sort: "created",
      limit: 100,
      locale: "en",
    });
    const second = await projectService.listByStudioForViewer(f.studioId, f.admin, {
      archived: false,
      sort: "created",
      cursor: first.nextCursor ?? undefined,
      limit: 100,
      locale: "en",
    });
    const page = { items: [...first.items, ...second.items] };
    const neverOpenedNeverEdited = page.items.find((p) => p.id === f.ids[119])!;
    expect(neverOpenedNeverEdited.lastOpenedAt).toBeNull();
    expect(new Date(neverOpenedNeverEdited.lastEditedAt).getTime()).toBe(
      new Date(neverOpenedNeverEdited.createdAt).getTime(),
    );
    expect(page.items.find((p) => p.id === f.ids[0])!.lastOpenedAt).not.toBeNull();
  });

  it("clamps a page size above the ceiling", async () => {
    const f = await bigStudio();
    const page = await projectService.listByStudioForViewer(f.studioId, f.admin, {
      archived: false,
      sort: "created",
      limit: 1000,
      locale: "en",
    });
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).not.toBeNull();
  });

  it("starts over from the first page on a cursor it cannot read", async () => {
    const f = await bigStudio();
    const first = await projectService.listByStudioForViewer(f.studioId, f.admin, {
      archived: false,
      sort: "created",
      limit: 50,
      locale: "en",
    });
    const garbage = await projectService.listByStudioForViewer(f.studioId, f.admin, {
      archived: false,
      sort: "created",
      cursor: "not-a-cursor",
      limit: 50,
      locale: "en",
    });
    expect(garbage.items.map((p) => p.id)).toEqual(first.items.map((p) => p.id));
  });

  it("starts over from the first page on a readable cursor holding values the database cannot take, and reports it", async () => {
    const f = await bigStudio();
    const id = "00000000-0000-4000-8000-000000000000";
    const encode = (c: object): string => Buffer.from(JSON.stringify(c)).toString("base64url");
    const forged: Array<[StudioProjectSort, string]> = [
      ["created", encode({ s: "created", createdAt: "garbage", id })],
      ["created", encode({ s: "created", createdAt: "2026-13-01 00:00:00+00", id })],
      ["created", encode({ s: "created", createdAt: "99999999999999999999", id })],
      ["name", encode({ s: "name", collation: "und-x-icu", name: "a\u0000b", id })],
    ];
    for (const [sort, cursor] of forged) {
      const first = await projectService.listByStudioForViewer(f.studioId, f.admin, {
        archived: false,
        sort,
        limit: 50,
        locale: "en",
      });
      const onRejectedCursor = vi.fn();
      const page = await projectService.listByStudioForViewer(f.studioId, f.admin, {
        archived: false,
        sort,
        cursor,
        limit: 50,
        locale: "en",
        onRejectedCursor,
      });
      expect(page.items.map((p) => p.id)).toEqual(first.items.map((p) => p.id));
      expect(onRejectedCursor).toHaveBeenCalledTimes(1);
    }
  });

  it("does not report a cursor it reads", async () => {
    const f = await bigStudio();
    const first = await projectService.listByStudioForViewer(f.studioId, f.admin, {
      archived: false,
      sort: "edited",
      limit: 50,
      locale: "en",
    });
    const onRejectedCursor = vi.fn();
    await projectService.listByStudioForViewer(f.studioId, f.admin, {
      archived: false,
      sort: "edited",
      cursor: first.nextCursor ?? undefined,
      limit: 50,
      locale: "en",
      onRejectedCursor,
    });
    expect(onRejectedCursor).not.toHaveBeenCalled();
  });

  it("starts over when a name cursor was made under another language", async () => {
    const f = await bigStudio();
    const zhFirst = await projectService.listByStudioForViewer(f.studioId, f.admin, {
      archived: false,
      sort: "name",
      limit: 50,
      locale: "zh-CN",
    });
    const enFirst = await projectService.listByStudioForViewer(f.studioId, f.admin, {
      archived: false,
      sort: "name",
      limit: 50,
      locale: "en",
    });
    const enFromZhCursor = await projectService.listByStudioForViewer(f.studioId, f.admin, {
      archived: false,
      sort: "name",
      cursor: zhFirst.nextCursor ?? undefined,
      limit: 50,
      locale: "en",
    });
    expect(enFromZhCursor.items.map((p) => p.id)).toEqual(enFirst.items.map((p) => p.id));
  });

  it("gives a non-member of the studio an empty page", async () => {
    const f = await bigStudio();
    const stranger = await insertUser();
    expect(
      await projectService.listByStudioForViewer(f.studioId, stranger, {
        archived: false,
        sort: "opened",
        limit: 50,
        locale: "en",
      }),
    ).toEqual({ items: [], nextCursor: null, total: 0 });
  });
});

describe("studio project list — archived", () => {
  it("pages the archived list by archive time, newest first, with its own total", async () => {
    const admin = await insertUser();
    const studioId = await insertStudio(admin);
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const id = await insertProject(studioId, admin, `p${i}`, "2026-01-01T00:00:00Z");
      await sql`
        UPDATE projects SET archived_at = ${`2026-02-0${1 + Math.floor(i / 2)}T00:00:00Z`}, archived_by_user_id = ${admin}
        WHERE id = ${id}
      `;
      ids.push(id);
    }
    await insertProject(studioId, admin, "live", "2026-01-01T00:00:00Z");

    const pages: string[] = [];
    let cursor: string | undefined;
    let total = -1;
    for (;;) {
      const page = await projectService.listByStudioForViewer(studioId, admin, {
        archived: true,
        sort: "archived",
        cursor,
        limit: 3,
        locale: "en",
      });
      pages.push(...page.items.map((p) => p.id));
      if (cursor === undefined) total = page.total ?? -1;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM projects WHERE studio_id = ${studioId} AND archived_at IS NOT NULL
      ORDER BY archived_at DESC, id DESC
    `;
    expect(pages).toEqual(rows.map((r) => r.id));
    expect(total).toBe(7);
  });
});

describe("project metadata writes record an edit", () => {
  it("a rename writes project_edits in the same transaction", async () => {
    const admin = await insertUser();
    const studioId = await insertStudio(admin);
    const projectId = await insertProject(studioId, admin, "before", "2026-01-01T00:00:00Z");

    await projectService.update(projectId, admin, { name: "after" });

    const rows = await sql`SELECT 1 FROM project_edits WHERE project_id = ${projectId}`;
    expect(rows.length).toBe(1);
  });

  it("a rename refused on an archived project writes no edit", async () => {
    const admin = await insertUser();
    const studioId = await insertStudio(admin);
    const projectId = await insertProject(studioId, admin, "before", "2026-01-01T00:00:00Z");
    await sql`UPDATE projects SET archived_at = now(), archived_by_user_id = ${admin} WHERE id = ${projectId}`;

    await expect(projectService.update(projectId, admin, { name: "after" })).rejects.toBeInstanceOf(
      ConflictError,
    );

    const rows = await sql`SELECT 1 FROM project_edits WHERE project_id = ${projectId}`;
    expect(rows.length).toBe(0);
  });
});
