// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1423 A17, design §9: the Agent's product guide tells the user where
 * the formula is and how it is written. The insert menu lists it right after
 * the table; a formula can also be typed as `$$…$$` in a line, and clicking
 * one opens a box to edit its LaTeX.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { loadLocales } from "@breatic/core";
import { t } from "@breatic/shared";

import { renderProductGuide } from "@domain/agent/tools/product-guide.js";

/**
 * One section of the rendered guide.
 * @param heading - The section's heading.
 * @returns Its text.
 */
function section(heading: string): string {
  return renderProductGuide().split(`## ${heading}`)[1]?.split("\n## ")[0] ?? "";
}

beforeAll(() => {
  loadLocales();
});

describe("the formula in the product guide", () => {
  it("lists the formula entry right after the table in the insert menu", () => {
    const doc = section("Document spaces");
    const table = `"${t("spaces.document.commands.table")}" on their own`;
    const formula = `"${t("spaces.document.commands.formula")}"`;
    expect(doc).toContain(formula);
    expect(doc.indexOf(formula)).toBeGreaterThan(doc.indexOf(table));
  });

  it("says a formula is typed between $$ and edited in a box opened by clicking it", () => {
    const doc = section("Document formulas");
    expect(doc).toMatch(/\$\$/);
    expect(doc).toMatch(/LaTeX/);
  });

  it("says every way out of the box keeps the change, with no cross to close it", () => {
    const paragraph = section("Document formulas");
    expect(paragraph).toMatch(/keeps? the change/);
    expect(paragraph).toMatch(/Cmd\+Z/);
    expect(paragraph).not.toMatch(/cross/);
  });

  it("says a key beside a formula on its own line selects it before a second press deletes it", () => {
    const doc = section("Document formulas");
    expect(doc).toMatch(/Backspace right under a formula or Delete right above it selects it; a second press deletes it/);
  });
});
