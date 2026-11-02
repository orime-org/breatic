// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { SceneImportLimits } from '@breatic/shared';
import { inspectModelFiles, isArchiverMetadata, normalizeModelPath, packModelFiles, unpackModelArchive } from '@web/spaces/three-d/model-package';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { contentFailure, ModelImportError } from '@web/spaces/three-d/model-import-errors';
import type { ModelInspectionInfo } from '@web/spaces/three-d/model-import-errors';
import type { ModelSource } from '@web/spaces/three-d/model-source';
import type { TextureFormatSupport } from '@web/spaces/three-d/model-texture-format';

export interface ModelSelection {
  model: ModelPackage;
  artifact: Uint8Array<ArrayBuffer>;
  entries: readonly string[];
  paths: readonly string[];
}

/**
 * Read one selected file, naming it when the browser cannot read it.
 * @param source - A selected file at its collection path.
 * @returns The file's bytes.
 * @throws {ModelImportError} When the browser cannot read the file.
 */
async function readSource(source: ModelSource): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await source.file.arrayBuffer());
  } catch (error) {
    throw new ModelImportError('invalid', error instanceof Error ? error.message : 'Unreadable model file', { detail: source.path });
  }
}

/**
 * Inspect local source bytes and produce the registered model artifact.
 * @param sources - Original files under their paths in the user's collection.
 * @param entry - Explicit selected model entry when several are present.
 * @param limits - Project's model import budgets.
 * @param support - The browser's WebP and AVIF support, probed on the main thread.
 * @returns Checked original resources and their deterministic artifact.
 * @throws {ModelImportError} When input, entries or resources need correction.
 */
export async function inspectModelSelection(sources: readonly ModelSource[], entry: string | undefined, limits: SceneImportLimits, support: TextureFormatSupport): Promise<ModelSelection> {
  let info: ModelInspectionInfo | undefined;
  try {
    const kept = sources.filter((source) => !isArchiverMetadata(normalizeModelPath(source.path)));
    if (kept.length > limits.maxFiles) {
      throw new ModelImportError('budget', 'Selected model files exceed their configured file count', { detail: '',
        budget: { limit: 'files', allowed: limits.maxFiles, actual: kept.length } });
    }
    const selectedBytes = kept.reduce((sum, source) => sum + source.file.size, 0);
    if (selectedBytes > limits.maxInputBytes) {
      throw new ModelImportError('budget', 'Selected model files exceed their configured input budget', { detail: '',
        budget: { limit: 'input', allowed: limits.maxInputBytes, actual: selectedBytes } });
    }
    // One ZIP beside no model entry is the collection; the other files fill its missing paths.
    const archives = kept.filter((source) => /\.zip$/i.test(source.path));
    const archive = archives.length === 1 && !kept.some((source) => /\.(glb|gltf)$/i.test(source.path)) ? archives[0] : undefined;
    const collection = archive ? unpackModelArchive(await readSource(archive), limits, false, archive.path) : new Map<string, Uint8Array<ArrayBuffer>>();
    for (const source of kept) {
      if (source === archive) continue;
      const path = normalizeModelPath(source.path);
      if (collection.has(path)) throw new ModelImportError('duplicate', `Duplicate model resource path: ${path}`, { detail: path });
      collection.set(path, await readSource(source));
    }
    const paths = [...collection.keys()].sort();
    const entries = paths.filter((path) => /\.(glb|gltf)$/i.test(path));
    info = { paths, entries, missing: [] };
    if (!entries.length) throw new ModelImportError('unsupported', 'No supported model entry was selected', { detail: '' });
    if ((!entry && entries.length > 1) || (entry !== undefined && !entries.includes(entry))) {
      throw new ModelImportError('entry', 'Choose a model entry', { detail: '' });
    }
    const selected = entry ?? entries[0];
    const model = inspectModelFiles(collection, selected, limits, support);
    return { model, artifact: packModelFiles(model, limits), entries, paths };
  } catch (error) {
    const failure = contentFailure(error);
    throw info ? failure.withInfo({ ...info, missing: failure.info?.missing ?? [] }) : failure;
  }
}
