// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the Agent's product guide says about the membership benefits
 * (inner#1968, test spec I-13; design section 6).
 *
 * The guide is rendered in zh-CN so that the on-screen text it quotes can be
 * matched against the sentences the confirmed demo and the web suites pin
 * ("排队中", "取消", "花费上限", "Project 协作者" and the spend-cap
 * sentence), whatever catalog keys the implementation picks. The guide's own
 * prose stays English.
 *
 * Shapes this suite chose where the design names none: the queued state and
 * its cancel are told in the "Generating" and "3D spaces" sections; the rule
 * that a task already running cannot be cancelled is said with "cannot be
 * cancelled" (or "can't" / "can no longer").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLocales } from "@breatic/core";
import { setLocale } from "@breatic/shared";

import { renderProductGuide } from "@domain/agent/tools/product-guide.js";

let sections: Map<string, string>;
let guide: string;

beforeAll(() => {
  loadLocales();
  setLocale("zh-CN");
  guide = renderProductGuide();
  sections = new Map(guide.split(/\n(?=## )/).map((part) => [part.split("\n")[0]!.slice(3), part] as const));
});

afterAll(() => {
  setLocale("en");
});

/**
 * One section of the zh-CN guide.
 * @param name - Its heading.
 * @returns Its text.
 * @throws {Error} When the guide has no such section.
 */
function section(name: string): string {
  const found = sections.get(name);
  if (found === undefined) throw new Error(`no section ${name}`);
  return found;
}

const CANNOT_CANCEL = /can(?:not|'t| no longer) be cancell?ed/i;

describe("I-13 the product guide on queueing and spend caps", () => {
  it("tells the queued state on a node with its reason, and that a queued task is cancelled from the count column and the task list", () => {
    const generating = section("Generating");
    expect(generating).toContain("排队中");
    expect(generating).toContain("你同时运行的任务已达上限");
    expect(generating).toContain('"取消"');
  });

  it("says a task that has started running cannot be cancelled", () => {
    expect(section("Generating")).toMatch(CANNOT_CANCEL);
  });

  it("tells the queued state and its cancel in the 3D task list", () => {
    const threeD = section("3D spaces");
    expect(threeD).toContain("排队中");
    expect(threeD).toContain('"取消"');
  });

  it("quotes the spend-cap sentence a refusal shows", () => {
    expect(guide).toContain("花费已到上限");
  });

  it("describes the spend caps of the Studio credits tab, project collaborators included", () => {
    const where = [...sections.values()].find((text) => text.includes('"花费上限"'));
    expect(where).toBeDefined();
    expect(where).toContain("Project 协作者");
  });
});
