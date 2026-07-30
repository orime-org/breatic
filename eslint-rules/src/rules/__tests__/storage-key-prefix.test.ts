// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, expect, it } from "vitest";
import { PREFIX, storageKeyPrefix } from "../storage-key-prefix";

const ruleTester = new RuleTester();

ruleTester.run("storage-key-prefix", storageKeyPrefix, {
  valid: [
    { code: `localStorage.getItem("breatic.locale");` },
    { code: `sessionStorage.setItem("breatic.draft", value);` },
    { code: `window.localStorage.removeItem("breatic.preferences");` },
    // Going through the registry is the intended path, and the registry's
    // own values are pinned by its unit test.
    { code: `localStorage.getItem(STORAGE_KEYS.locale);` },
    { code: `localStorage.setItem(key, value);` },
    { code: "localStorage.getItem(`breatic.${suffix}`);" },
    // A different object that happens to share a method name.
    { code: `cache.getItem("anything");` },
    { code: `map.set("anything", 1);` },
    // Prefixed bracket access.
    { code: `localStorage["breatic.locale"];` },
  ],
  invalid: [
    {
      code: `localStorage.getItem("rail.myStudios");`,
      errors: [{ messageId: "bareKey", data: { key: "rail.myStudios", prefix: "breatic." } }],
    },
    {
      code: `sessionStorage.setItem("draft", value);`,
      errors: [{ messageId: "bareKey" }],
    },
    {
      code: `window.localStorage.removeItem("theme");`,
      errors: [{ messageId: "bareKey" }],
    },
    // Whitespace between the parts, which the guard's regex also handled.
    {
      code: `sessionStorage . removeItem ( "bad" );`,
      errors: [{ messageId: "bareKey" }],
    },
    // Bracket access reads and writes a key without calling a method — the
    // guard's regex required one of three method names.
    {
      code: `const v = localStorage["theme"];`,
      errors: [{ messageId: "bareKey" }],
    },
    {
      code: `localStorage["theme"] = "dark";`,
      errors: [{ messageId: "bareKey" }],
    },
    // An uninterpolated template literal is as fixed as a quoted string.
    {
      code: "localStorage.getItem(`theme`);",
      errors: [{ messageId: "bareKey" }],
    },
    // Two accesses on one line are two findings; the guard reported the
    // line once.
    {
      code: `localStorage.getItem("a"); localStorage.getItem("b");`,
      errors: [{ messageId: "bareKey" }, { messageId: "bareKey" }],
    },
    // A key that merely contains the prefix does not start with it.
    {
      code: `localStorage.getItem("app.breatic.locale");`,
      errors: [{ messageId: "bareKey" }],
    },
  ],
});

describe("the prefix it enforces", () => {
  it("is the one the product declares", () => {
    // The rule cannot read the registry at lint time — eslint's working
    // directory is whichever package it was started in — so the two are
    // kept in step here instead. Change one and this fails rather than
    // the rule quietly enforcing a string nothing uses.
    const registry = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../packages/web/src/lib/storage-keys.ts",
      ),
      "utf8",
    );
    const declared = /STORAGE_PREFIX\s*=\s*['"`]([^'"`]+)/.exec(registry);
    expect(declared?.[1]).toBe(PREFIX);
  });
});
