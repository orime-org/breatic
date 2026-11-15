// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { t } from "@shared/i18n/index.js";

/** What one input limit counts and where it stops, as `@breatic/provider` states it on a reject. */
export interface InputLimitShape {
  readonly field: string;
  readonly measure: "characters" | "lines";
  readonly max?: number;
  readonly min?: number;
  readonly per?: "line" | "item";
}

/** Why no upstream takes a run, as `@breatic/provider` answers it: a value it does not take, or a limit's words. */
export type InputRefusalShape =
  | { readonly param: string; readonly value: unknown }
  | { readonly reason: string; readonly evaluationError?: string; readonly limit?: InputLimitShape };

/** The params a limit can be on that have a name of their own; any other reads as the text. */
const NAMED_FIELDS = new Set(["prompt", "negative_prompt", "lyrics", "multi_prompt"]);

/**
 * The sentence for a limit, when there is one for its kind.
 * @param limit - The limit.
 * @returns The message key and its count, or undefined.
 * @throws {never} Never.
 */
function sentenceOf(limit: InputLimitShape): { key: string; count: number; name: "max" | "min" } | undefined {
  const base = "server.model.input_limit";
  if (limit.max !== undefined) {
    if (limit.measure === "lines") return limit.per === undefined ? { key: `${base}.lines_max`, count: limit.max, name: "max" } : undefined;
    const kind = limit.per === "line" ? "line_characters_max" : limit.per === "item" ? "item_characters_max" : "characters_max";
    return { key: `${base}.${kind}`, count: limit.max, name: "max" };
  }
  if (limit.min !== undefined && limit.measure === "characters" && limit.per === undefined) {
    return { key: `${base}.characters_min`, count: limit.min, name: "min" };
  }
  return undefined;
}

/**
 * Tell the user, in their language, why a model takes no run as set up (#1521): the limit the run broke when the
 * refusal states a count, else that the settings do not suit the model. One sentence, the same on the panel, in the
 * server's refusal and on a failed node.
 * @param refusal - The refusal of the first upstream the run's route would try.
 * @param model - What the user knows the model as.
 * @returns The sentence.
 * @throws {never} Never.
 */
export function inputRefusalText(refusal: InputRefusalShape, model: string): string {
  const limit = "limit" in refusal ? refusal.limit : undefined;
  const sentence = limit === undefined ? undefined : sentenceOf(limit);
  if (limit === undefined || sentence === undefined) return t("server.model.input_limit.unsupported", { model });
  const field = t(`server.model.input_field.${NAMED_FIELDS.has(limit.field) ? limit.field : "prompt"}`);
  return t(sentence.key, { model, field, [sentence.name]: sentence.count });
}
