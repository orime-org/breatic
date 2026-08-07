// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Rescue files: the last copy of a document's content when the database will
 * not take it (#40).
 *
 * Written when a document is about to leave memory with content the database
 * never accepted. From that moment nothing else holds it — the browser has
 * gone, the process may be about to, and no retry has anywhere to run.
 *
 * They are never cleaned up automatically. A rescue file is the only
 * remaining copy of somebody's work, so deleting it on a schedule would be a
 * second loss. The alert that accompanies it tells an operator where to look;
 * removing it afterwards is their call.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Everything needed to write one rescue file. */
export interface RescueFileRequest {
  /** Directory rescue files live in. */
  dir: string;
  /** Full Yjs document name. */
  documentName: string;
  /** The bytes that could not be stored. */
  state: Uint8Array;
  /** Which collab instance produced it — the file only exists on that host. */
  instanceId: string;
}

/**
 * Turn a document name into something safe to use as a file name.
 *
 * Document names carry slashes (`project-{id}/document-{id}`), and a name
 * arriving from a client is not trusted to stay inside the directory.
 * @param documentName - Full Yjs document name.
 * @returns The name with every path-significant character replaced.
 */
function flattenDocumentName(documentName: string): string {
  return documentName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Write a document's unstorable content to disk.
 *
 * The file name carries the instance and the document because the alert that
 * follows has to point an operator at one file on one host. A random suffix
 * keeps a second failure for the same document from erasing the first — two
 * failures are two different pieces of content.
 * @param request - Directory, document, bytes, and instance.
 * @returns Absolute path of the file written.
 * @throws {Error} When the directory cannot be created or the file cannot be written.
 */
export async function writeRescueFile(request: RescueFileRequest): Promise<string> {
  const { dir, documentName, state, instanceId } = request;
  await mkdir(dir, { recursive: true });
  const name = `${instanceId}__${flattenDocumentName(documentName)}__${randomUUID()}.yjs`;
  const path = join(dir, name);
  await writeFile(path, state);
  return path;
}

/** What the note beside a rescue file records about it. */
export interface RescueNote {
  /** Full Yjs document name, unflattened. */
  documentName: string;
  /** Which collab instance wrote the file. */
  instanceId: string;
  /** Size of the rescued content. */
  bytes: number;
  /** Why the content is unaccounted for, in the same words the alert carries. */
  reason: string;
  /** When the note was written, ISO 8601. */
  writtenAt: string;
}

/**
 * Write the note that says what a rescue file is.
 *
 * Without it the rescue directory is a pile of opaque binaries whose names have
 * been flattened for the filesystem — every path-significant character replaced
 * — so there is no way back from a file to the document it holds, let alone to
 * why it is there. The note is JSON because the thing that will eventually read
 * it is a reconciliation job, not a person.
 *
 * Written once the reason is known rather than alongside the bytes: on the way
 * out the file is written BEFORE the store is attempted, so at that moment
 * there is no reason to record yet.
 * @param rescuePath - Path returned by {@link writeRescueFile}.
 * @param note - What to record about it.
 * @throws {Error} When the note cannot be written.
 */
export async function writeRescueNote(rescuePath: string, note: RescueNote): Promise<void> {
  await writeFile(`${rescuePath}.json`, `${JSON.stringify(note, null, 2)}\n`);
}

/**
 * Remove a rescue file, once its content has reached the database after all.
 *
 * Quiet when the file is already gone: on shutdown this runs inside a budget
 * measured in seconds, and a failed delete must never be the reason the
 * process does not finish shutting down.
 * @param path - Path returned by {@link writeRescueFile}.
 */
export async function deleteRescueFile(path: string): Promise<void> {
  // The note goes with it. It only ever exists once the content was written off,
  // so in the ordinary case there is nothing here to remove — but a note left
  // behind pointing at a file that no longer exists would be worse than no note
  // at all: it says a document was lost when it was not.
  await Promise.all([rm(path, { force: true }), rm(`${path}.json`, { force: true })]);
}
