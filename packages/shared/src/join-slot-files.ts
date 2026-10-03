// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Folds a joining slot into the pool it names (inner#826).
 *
 * Some models take style images through their ordinary image list, told
 * apart only by the prompt. Such a model declares the style slot with
 * `joins` (the pool) and `prompt_note` (the sentence naming the files). The
 * worker runs this on the way upstream and the price estimate runs it on the
 * same params, so what is quoted is what is sent.
 */

import { usableUrls } from "@shared/item-cap.js";

/**
 * The three fields this reads off each declaration. Loose on purpose: the
 * worker hands in the yaml-shaped entry and the panel the wire descriptor.
 */
export type JoinDeclarations = Readonly<Record<string, object>>;

/** The fields read off one declaration. */
interface JoinFields {
  readonly joins?: unknown;
  readonly prompt_note?: unknown;
  readonly mention?: unknown;
}

/** A run's params and prompt after its joining slots are folded in. */
export interface JoinedRun {
  /** The params, joining slots removed and their files appended to their pools. */
  readonly params: Record<string, unknown>;
  /** The prompt with each joining slot's note appended. */
  readonly prompt: string;
}

/**
 * Names a run of files in reading order: "a", "a and b", "a, b and c".
 * @param names - The names in order.
 * @returns The phrase.
 */
function listPhrase(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Appends every joining slot's files to its pool and its note to the prompt.
 * @param declared - The model's parameter declarations.
 * @param params - The run's params under our names.
 * @param prompt - The prompt as the model reads it.
 * @returns The params and prompt to send.
 */
export function joinSlotFiles(
  declared: JoinDeclarations,
  params: Readonly<Record<string, unknown>>,
  prompt: string,
): JoinedRun {
  const out: Record<string, unknown> = { ...params };
  let text = prompt;
  for (const [name, spec] of Object.entries(declared)) {
    const { joins, prompt_note: note } = spec as JoinFields;
    if (typeof joins !== "string" || typeof note !== "string") continue;
    const files = usableUrls(out[name]);
    delete out[name];
    if (files.length === 0) continue;
    const pool = usableUrls(out[joins]);
    const declaredMention = (declared[joins] as JoinFields | undefined)?.mention;
    const mention = typeof declaredMention === "string" ? declaredMention : "image {n}";
    const names = files.map((_, k) => {
      const index = pool.length + k;
      return mention.replace("{n}", String(index + 1)).replace("{i}", String(index));
    });
    out[joins] = [...pool, ...files];
    const said = note.replace("{list}", listPhrase(names));
    text = text.length > 0 ? `${text} ${said}` : said;
  }
  return { params: out, prompt: text };
}
