// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The rescue file is the last copy of a document's content when the database
 * will not take it. Everything about it is chosen so that an operator who
 * gets the alert can find the file and read it back.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

import { deleteRescueFile, writeRescueFile } from "@collab/services/rescue-file.js";

const DOC = "project-11111111-1111-4111-8111-111111111111/document-1";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rescue-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Bytes of a document carrying some text. */
function bytesOf(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

describe("writeRescueFile", () => {
  it("writes bytes that decode back to the original content", async () => {
    const state = bytesOf("content that must not vanish");

    const path = await writeRescueFile({ dir, documentName: DOC, state, instanceId: "inst-a" });

    const back = new Y.Doc();
    Y.applyUpdate(back, await readFile(path));
    expect(back.getText("body").toString()).toBe("content that must not vanish");
  });

  it("creates the directory when it is not there yet", async () => {
    const nested = join(dir, "does", "not", "exist");

    const path = await writeRescueFile({
      dir: nested,
      documentName: DOC,
      state: bytesOf("x"),
      instanceId: "inst-a",
    });

    expect(await readFile(path)).toBeDefined();
  });

  it("puts the document name and the instance in the file name", async () => {
    // The alert points an operator at one file on one machine; if the name
    // does not carry both, the alert is a dead end.
    const path = await writeRescueFile({
      dir,
      documentName: DOC,
      state: bytesOf("x"),
      instanceId: "inst-a",
    });

    const name = path.slice(path.lastIndexOf("/") + 1);
    expect(name).toContain("inst-a");
    expect(name).toContain("document-1");
  });

  it("keeps a document name with slashes from escaping the directory", async () => {
    const path = await writeRescueFile({
      dir,
      documentName: "../../etc/passwd",
      state: bytesOf("x"),
      instanceId: "inst-a",
    });

    expect(path.startsWith(dir)).toBe(true);
  });

  it("does not overwrite an earlier rescue of the same document", async () => {
    // Two failures for one document are two separate pieces of content. The
    // second must not erase the first.
    await writeRescueFile({ dir, documentName: DOC, state: bytesOf("first"), instanceId: "i" });
    await writeRescueFile({ dir, documentName: DOC, state: bytesOf("second"), instanceId: "i" });

    expect(await readdir(dir)).toHaveLength(2);
  });
});

describe("deleteRescueFile", () => {
  it("removes a file written moments earlier", async () => {
    const path = await writeRescueFile({
      dir,
      documentName: DOC,
      state: bytesOf("x"),
      instanceId: "i",
    });

    await deleteRescueFile(path);

    expect(await readdir(dir)).toHaveLength(0);
  });

  it("is quiet about a file that is already gone", async () => {
    // On shutdown the file is written first and deleted once the database
    // takes the content. A failure to delete must never become the reason a
    // shutdown does not finish.
    await expect(deleteRescueFile(join(dir, "not-there"))).resolves.toBeUndefined();
  });
});
