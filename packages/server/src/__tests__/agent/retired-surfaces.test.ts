// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What this work took out, and stays out (#148, A5 A6).
 *
 * Both halves are the same failure if they come back: a surface with no
 * meaning behind it. A config key with a schema entry, a value in the file and
 * no reader is a dial that turns nothing. A memory field with a type, a name
 * and nothing writing it is a layer the next reader will assume exists.
 *
 * Neither is visible to the compiler — an unread key type-checks, and a field
 * that is always the empty string satisfies every consumer — so they are
 * asserted against the source itself.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the packages sit, relative to this file. */
const PACKAGES = fileURLToPath(new URL("../../../../", import.meta.url));

/** This file, which names the retired field in order to look for it. */
const SELF = fileURLToPath(import.meta.url);

/**
 * Every TypeScript source file under a directory.
 * @param dir - Where to start.
 * @returns Absolute paths, in no particular order.
 */
function sourcesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourcesUnder(path));
    } else if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      found.push(path);
    }
  }
  return found;
}

describe("the user memory layer", () => {
  it("is gone from every package that used to carry it", () => {
    // A5. It spanned four: the two tables in core, the type in shared, the
    // prompt section in domain, and the reads and writes in server. A
    // leftover in any one of them is a layer that looks live to the next
    // reader — a declared table most of all, since it comes with a unique
    // index and a name that reads as current.
    //
    // The needle is the stem: the field was `userMemory`, the tables were
    // `userMemories`, and a search for the field alone walks past both.
    const offenders: string[] = [];
    for (const pkg of ["core", "shared", "domain", "server"]) {
      for (const file of sourcesUnder(join(PACKAGES, pkg, "src"))) {
        if (file === SELF) continue;
        if (readFileSync(file, "utf8").includes("userMemor")) {
          offenders.push(file.slice(PACKAGES.length));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("leaves the context builder asking for the three ids its two layers are keyed by", () => {
    // Every one of them is half of a key: conversation memory is keyed by the
    // conversation, project memory by the member and the project together.
    // An optional one is a layer that silently comes back empty, and the
    // caller gets no complaint from anywhere.
    //
    // Read off the source because optionality is a type-level mark: it is
    // erased at runtime, so `buildContext.length` counts an optional
    // parameter and a required one the same way and cannot tell them apart.
    const service = readFileSync(
      join(PACKAGES, "server", "src", "modules", "memory", "memory.service.ts"),
      "utf8",
    );
    const start = service.indexOf("export async function buildContext(");
    const signature = service.slice(start, service.indexOf(")", start));

    expect(signature).not.toContain("?:");
    expect(signature).not.toContain("Scenario");
  });

  it("leaves the context builder describing the two layers it has", () => {
    const service = readFileSync(
      join(PACKAGES, "server", "src", "modules", "memory", "memory.service.ts"),
      "utf8",
    );
    const docstring = service.slice(0, service.indexOf("export async function buildContext"));

    expect(docstring).toContain("project + conversation memory");
    expect(docstring).not.toContain("user +");
  });
});

describe("the config keys this work retires", () => {
  it("leaves none of them behind, in the schema or in the file", () => {
    // A6.
    const retired = [
      "memory_window",
      "memory_keep_recent_turns",
      "memory_user_max_size",
      "full_detail_turns",
    ];

    const loader = readFileSync(
      join(PACKAGES, "core", "src", "config", "loader.ts"),
      "utf8",
    );
    const yaml = readFileSync(
      join(PACKAGES, "..", "config", "agent.yaml"),
      "utf8",
    );

    for (const key of retired) {
      expect(loader).not.toContain(key);
      expect(yaml).not.toContain(key);
    }
  });
});
