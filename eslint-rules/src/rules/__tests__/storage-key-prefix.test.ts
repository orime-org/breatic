// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { storageKeyPrefix } from "../storage-key-prefix";

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
