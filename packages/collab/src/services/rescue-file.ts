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

/**
 * Remove a rescue file, once its content has reached the database after all.
 *
 * Quiet when the file is already gone: on shutdown this runs inside a budget
 * measured in seconds, and a failed delete must never be the reason the
 * process does not finish shutting down.
 * @param path - Path returned by {@link writeRescueFile}.
 */
export async function deleteRescueFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
