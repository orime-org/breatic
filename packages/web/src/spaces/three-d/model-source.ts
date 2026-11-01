// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** One original file and the path it occupies in the user's model collection. */
export interface ModelSource {
  path: string;
  file: File;
}

/**
 * Map picker files to their folder-relative path, or their name for loose files.
 * @param files - Files from a file or folder picker.
 * @returns Sources in picker order.
 * @throws {never} Never.
 */
export function sourcesFromFiles(files: readonly File[]): ModelSource[] {
  return files.map((file) => ({ path: file.webkitRelativePath || file.name, file }));
}

/**
 * Place each added file at the one missing resource path that ends in its name.
 * A file whose name matches several missing paths, or none, is left out, so the missing list stays as it was.
 * @param files - Files the user added for missing resources.
 * @param missing - Resolved paths the last inspection reported as missing.
 * @returns Sources at their missing paths.
 * @throws {never} Never.
 */
export function supplementSources(files: readonly File[], missing: readonly string[]): ModelSource[] {
  return files.flatMap((file) => {
    const matches = missing.filter((path) => path.slice(path.lastIndexOf('/') + 1) === file.name);
    return matches.length === 1 ? [{ path: matches[0], file }] : [];
  });
}

/**
 * Read every file of a dropped directory, following the reader until it returns an empty batch.
 * @param directory - A dropped directory entry.
 * @returns Its file entries at any depth.
 * @throws {DOMException} When the browser cannot read the directory.
 */
async function directoryFiles(directory: FileSystemDirectoryEntry): Promise<FileSystemFileEntry[]> {
  const reader = directory.createReader();
  const found: FileSystemFileEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => { reader.readEntries(resolve, reject); });
    if (!batch.length) return found;
    for (const entry of batch) {
      if (entry.isDirectory) found.push(...await directoryFiles(entry as FileSystemDirectoryEntry));
      else if (entry.isFile) found.push(entry as FileSystemFileEntry);
    }
  }
}

/**
 * Read dropped files and folders with their paths inside the drop.
 * The item list is read before the first await because the browser empties it once the drop handler returns.
 * @param transfer - The drop event's data transfer.
 * @returns Sources for every dropped file, folders expanded.
 * @throws {DOMException} When the browser cannot read a dropped file or directory.
 */
export async function sourcesFromDrop(transfer: DataTransfer): Promise<ModelSource[]> {
  const dropped = Array.from(transfer.items).filter((item) => item.kind === 'file')
    .map((item) => ({ entry: item.webkitGetAsEntry(), file: item.getAsFile() }));
  const sources: ModelSource[] = [];
  for (const { entry, file } of dropped) {
    if (!entry) { if (file) sources.push({ path: file.name, file }); continue; }
    const entries = entry.isDirectory ? await directoryFiles(entry as FileSystemDirectoryEntry) : [entry as FileSystemFileEntry];
    for (const fileEntry of entries) {
      sources.push({ path: fileEntry.fullPath.replace(/^\/+/, ''), file: await new Promise<File>((resolve, reject) => { fileEntry.file(resolve, reject); }) });
    }
  }
  return sources;
}
