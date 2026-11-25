// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * One rule says what a focus image is, wherever it is read (#1580, test spec PT-8, D-11, D-33; design §2.4): the
 * pool read the page and collab use, and the `focusImage` the upload ticket takes, which also needs a UUID and the
 * node it lands on. The append collab runs, inside a crop's upload step, is one function too, exported once from
 * `@breatic/shared/space-content`.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  focusImageTicketSchema,
  isValidFocusImage,
  MAX_FOCUS_DIMENSION,
  MAX_FOCUS_NAME,
  validFocusImages,
} from "@shared/canvas/focus-images.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dimension = fc.oneof(
  fc.constantFrom(0, -1, 0.25, 1, 123.5, MAX_FOCUS_DIMENSION, MAX_FOCUS_DIMENSION + 1, Number.NaN, Number.POSITIVE_INFINITY),
  fc.double({ min: -10, max: MAX_FOCUS_DIMENSION * 2, noNaN: false }),
  fc.constantFrom("10" as unknown, null as unknown, undefined as unknown),
);
const name = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.constantFrom("", "n".repeat(MAX_FOCUS_NAME), "n".repeat(MAX_FOCUS_NAME + 1)),
  fc.constantFrom(7 as unknown, null as unknown),
);
const id = fc.oneof(fc.uuid(), fc.constantFrom("", "abc", "x".repeat(129)));
const sample = fc.record({ id, name, width: dimension, height: dimension });

describe("PT-8 the focus image rule", () => {
  it("accepts the same shapes in the pool read, the single check and the ticket, the ticket also asking a UUID and a node", () => {
    fc.assert(
      fc.property(sample, fc.oneof(fc.uuid(), fc.constant("")), (s, nodeId) => {
        const valid = isValidFocusImage({ ...s, url: "https://assets.example.test/a.png" });
        expect(validFocusImages([{ ...s, url: "https://assets.example.test/a.png" }]).length).toBe(valid ? 1 : 0);
        const ticketOk = focusImageTicketSchema.safeParse({ ...s, nodeId }).success;
        expect(ticketOk).toBe(valid && typeof s.id === "string" && UUID.test(s.id) && nodeId !== "");
      }),
      { numRuns: 200 },
    );
  });
});

const PACKAGES = path.join(import.meta.dirname, "..", "..", "..", "..");

/**
 * A source file under `packages/`.
 * @param file - Its path below `packages/`.
 * @returns Its text.
 */
function source(file: string): string {
  return readFileSync(path.join(PACKAGES, file), "utf8");
}

describe("the focus image rule has one home", () => {
  it("D-11 the ticket, the page's pool read and collab's append take it from shared", () => {
    expect(source("server/src/routes/assets.ts")).toMatch(/focusImageTicketSchema[\s\S]*from "@breatic\/shared"|from "@breatic\/shared"[\s\S]*focusImageTicketSchema/);
    // The page's own copy of the pool read is gone; every web reader imports the shared one.
    expect(existsSync(path.join(PACKAGES, "web/src/data/focus-images.ts"))).toBe(false);
    expect(source("shared/src/space-content.ts")).toMatch(/appendFocusImageCore/);
  });

  it("D-33 the append is written once, in shared, and web keeps no copy", () => {
    expect(source("web/src/data/yjs/canvas-space.ts")).not.toMatch(/function appendFocusImageCore/);
    expect(source("collab/src/services/task-listener.ts")).toMatch(/import \{ applyFocusImageUpload \} from "@breatic\/shared\/space-content"/);
    expect(source("shared/src/canvas/focus-image-append.ts")).toMatch(/appendFocusImageCore\(data, event\.image\)/);
  });
});
