// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { SceneImportLimits } from '@breatic/shared';
import { inspectModelFiles, normalizeModelPath, packModelFiles, unpackModelArchive } from '@web/spaces/three-d/model-package';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import type { ModelInspectionInfo } from '@web/spaces/three-d/model-import-errors';

export interface ModelSelection {
  model: ModelPackage;
  artifact: Uint8Array<ArrayBuffer>;
  entries: readonly string[];
  paths: readonly string[];
}

/**
 * Inspect local source bytes and produce the registered model artifact.
 * @param files - Original browser files, including folder-relative paths.
 * @param entry - Explicit selected model entry when several are present.
 * @param limits - Project's model import budgets.
 * @returns Checked original resources and their deterministic artifact.
 * @throws {ModelImportError} When input, entries or resources need correction.
 */
export async function inspectModelSelection(files: readonly File[], entry: string | undefined, limits: SceneImportLimits): Promise<ModelSelection> {
  let info: ModelInspectionInfo | undefined;
  try {
    if (!files.length) throw new ModelImportError('empty', 'No model files were selected');
    if (files.length > limits.maxFiles || files.reduce((sum, file) => sum + file.size, 0) > limits.maxInputBytes) {
      throw new ModelImportError('budget', 'Selected model files exceed their configured input budget');
    }
    let collection = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const file of files) {
      const path = normalizeModelPath(file.webkitRelativePath || file.name);
      if (collection.has(path)) throw new ModelImportError('duplicate', `Duplicate model resource path: ${path}`, undefined, path);
      collection.set(path, new Uint8Array(await file.arrayBuffer()));
    }
    if (files.length === 1 && files[0].name.toLowerCase().endsWith('.zip')) {
      collection = unpackModelArchive([...collection.values()][0], limits);
    }
    const paths = [...collection.keys()].sort();
    const entries = paths.filter((path) => /\.(glb|gltf)$/i.test(path));
    info = { paths, entries, missing: [] };
    if (!entries.length) throw new ModelImportError('unsupported', 'No supported model entry was selected');
    if ((!entry && entries.length > 1) || (entry !== undefined && !entries.includes(entry))) {
      throw new ModelImportError('entry', 'Choose a model entry');
    }
    const selected = entry ?? entries[0];
    const model = inspectModelFiles(collection, selected, limits);
    return { model, artifact: packModelFiles(collection, selected, limits), entries, paths };
  } catch (error) {
    if (error instanceof ModelImportError) {
      throw new ModelImportError(error.code, error.message, info ? { ...info, missing: error.info?.missing ?? [] } : error.info, error.detail);
    }
    throw new ModelImportError('invalid', error instanceof Error ? error.message : 'Invalid model data', info);
  }
}
