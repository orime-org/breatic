// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Generation templates (inner#977): a fixed mode, model, params and prompt a
 * reader picks in a generate panel, and the agent may start a proposed node
 * from. The prompt is interface text, so it lives in the locale files under
 * `canvas.template.<id>.prompt`, with the places the reader acts on written as
 * the proposal marks: `[📎 …]` for material to @, `{✏️ …}` for words to fill
 * in, `(💡 …)` for a note on operating the panel.
 *
 * The mode, model, ratio and wording of the two image templates come from real
 * runs on Nano Banana Pro Ultra: a fixed ratio keeps the reference's own frame
 * and background out of the result, and the costume sheet needs the
 * photographic style and the hairstyle named or it drifts.
 */

import { t } from "@shared/i18n/index.js";
import { markedSegments, type PromptSegment } from "@shared/types/canvas-proposal.js";
import type { GenerationNodeType } from "@shared/types/model-catalog.js";

/** One template: a fixed way to generate, with the places the reader fills in. */
export interface GenerationTemplate {
  /** Stable id: the panel, the agent and the locale keys name it by this. */
  id: string;
  /** The generate panel that lists it. */
  nodeType: GenerationNodeType;
  /** A mode of `config/models/modes.yaml`. */
  mode: string;
  /** A model name of the catalog. */
  model: string;
  /** Only the params the template fixes. */
  params: Readonly<Record<string, unknown>>;
  /** How many reference images its prompt asks for: its `[📎 …]` marks in every language. */
  references: number;
  /** What it makes and what it is for, in the words the agent reads. */
  agentNote: string;
}

const STORYBOARD_GRID_25: GenerationTemplate = {
  id: "storyboard-grid-25",
  nodeType: "image",
  mode: "i2i",
  model: "nano-banana-pro-edit-ultra",
  params: { aspect_ratio: "1:1", resolution: "4k" },
  references: 1,
  agentNote:
    "one 5x5 storyboard picture of a continuous story, the same characters and place in every panel; made to be turned into a video afterwards",
};

const COSTUME_SHEET: GenerationTemplate = {
  id: "costume-sheet",
  nodeType: "image",
  mode: "i2i",
  model: "nano-banana-pro-edit-ultra",
  params: { aspect_ratio: "16:9", resolution: "4k" },
  references: 1,
  agentNote:
    "a character costume sheet: front, side and back full-body views plus close-ups of the hands or another body part, for keeping a character consistent",
};

/** Every template, in the order the panels list them. */
export const GENERATION_TEMPLATES: readonly GenerationTemplate[] = [STORYBOARD_GRID_25, COSTUME_SHEET];

/**
 * The templates a generate panel lists.
 * @param nodeType - The panel's node type.
 * @returns Its templates, possibly none.
 */
export function templatesFor(nodeType: GenerationNodeType): readonly GenerationTemplate[] {
  return GENERATION_TEMPLATES.filter((template) => template.nodeType === nodeType);
}

/**
 * A template by id.
 * @param id - The template id.
 * @returns The template, or undefined for an id the registry does not have.
 */
export function findTemplate(id: string): GenerationTemplate | undefined {
  return GENERATION_TEMPLATES.find((template) => template.id === id);
}

/**
 * A template's prompt in the reader's language.
 * @param template - The template.
 * @returns The prompt segments.
 */
export function templatePrompt(template: GenerationTemplate): PromptSegment[] {
  return markedSegments(t(`canvas.template.${template.id}.prompt`));
}
