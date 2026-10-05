// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The camera commands a model reads out of its prompt, as the
 * yaml declares them and as the wire ships them.
 */

import { isCameraCommand, type CameraCommandEntry } from "@breatic/shared";

import { voiceSampleUrl } from "@domain/model-catalog/voice-sample-config.js";

/** One declared command: its name and the key of the clip that previews it. */
export interface DeclaredCameraCommand {
  /** The command as written inside the brackets. */
  name: string;
  /** The clip's path under `config/voice-samples.json`'s `base_url`. */
  sample_key: string;
}

/** The part of a catalog entry this check reads. */
interface CameraCommandCandidate {
  /** Model name as authored in yaml, named in the error. */
  name: string;
  /** What the model declares, unchecked. */
  camera_commands?: unknown;
}

/**
 * Why one declared command is wrong, or null when it is right.
 * @param entry - The declared entry, unchecked.
 * @param names - Command names declared before it on the same model.
 * @param commandOf - The command each clip key already belongs to, across the modality.
 * @returns The reason, naming the command where it has one.
 */
function wrongWith(
  entry: unknown,
  names: ReadonlySet<string>,
  commandOf: ReadonlyMap<string, string>,
): string | null {
  const { name, sample_key: key } = (entry ?? {}) as { name?: unknown; sample_key?: unknown };
  if (typeof name !== "string" || !isCameraCommand(name)) {
    return `declares camera command '${String(name)}', which MiniMax does not document`;
  }
  if (names.has(name)) return `declares camera command '${name}' twice`;
  if (typeof key !== "string" || key.length === 0 || /\s/.test(key)) {
    return `declares camera command '${name}' without a whitespace-free sample_key`;
  }
  // One clip shows one motion; a second command on it would preview as the first.
  const owner = commandOf.get(key);
  if (owner !== undefined && owner !== name) {
    return `declares camera command '${name}' with sample_key '${key}', already the clip for '${owner}'`;
  }
  return null;
}

/**
 * Assert that every model in one modality declares its camera commands as
 * documented names, once each, each with a clip key that only ever shows that
 * command — entries may share a clip, never for different commands.
 * @param modality - The modality being loaded, named in the error.
 * @param models - The models parsed out of that modality's yaml files.
 * @throws {Error} when a model declares a malformed list.
 */
export function assertCameraCommands(
  modality: string,
  models: readonly CameraCommandCandidate[],
): void {
  const commandOf = new Map<string, string>();
  for (const model of models) {
    if (model.camera_commands === undefined) continue;
    if (!Array.isArray(model.camera_commands)) {
      throw new Error(`config/models/${modality}: ${model.name} declares camera_commands that is not a list`);
    }
    const names = new Set<string>();
    for (const entry of model.camera_commands as unknown[]) {
      const wrong = wrongWith(entry, names, commandOf);
      if (wrong !== null) throw new Error(`config/models/${modality}: ${model.name} ${wrong}`);
      const { name, sample_key: key } = entry as DeclaredCameraCommand;
      names.add(name);
      commandOf.set(key, name);
    }
  }
}

/**
 * The commands as the wire ships them, each with the address its clip plays from.
 * @param declared - What the model declares; checked by {@link assertCameraCommands}.
 * @returns The shipped list, or undefined when the model declares none.
 * @throws {Error} When `config/voice-samples.json` is missing or malformed.
 */
export function shipCameraCommands(
  declared: readonly DeclaredCameraCommand[] | undefined,
): CameraCommandEntry[] | undefined {
  return declared?.map((command) => ({
    name: command.name,
    preview_url: voiceSampleUrl(command.sample_key),
  }));
}
