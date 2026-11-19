// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { backendConfig } from "#rules/backend-config";

/** The repository root, where `config/provider/upstreams.yaml` lives. */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("backendConfig", () => {
  it("scopes every block to the packages it is given", () => {
    const blocks = backendConfig({ packages: ["packages/commerce"], rootDir: ROOT });
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.files?.length).toBeGreaterThan(0);
      for (const glob of block.files ?? []) expect(String(glob).startsWith("packages/commerce/")).toBe(true);
    }
  });

  it("carries the backend guards a service package is held to", () => {
    const rules = Object.assign({}, ...backendConfig({ packages: ["packages/x"], rootDir: ROOT }).map((b) => b.rules ?? {}));
    for (const id of [
      "drizzle/enforce-update-with-where",
      "jsdoc/require-jsdoc",
      "breatic/no-relative-import",
      "breatic/no-naked-fetch",
      "breatic/no-raw-body-parse",
      "breatic/no-missing-license-header",
    ]) {
      expect(rules).toHaveProperty([id]);
    }
  });

  it("holds only each package's entry file to the service wiring rule", () => {
    const block = backendConfig({ packages: ["packages/a", "packages/b"], rootDir: ROOT }).find(
      (b) => b.rules?.["breatic/service-observability"] !== undefined,
    );
    expect(block?.files).toEqual(["packages/a/src/index.ts", "packages/b/src/index.ts"]);
  });
});
