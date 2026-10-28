// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Generation templates (inner#977, inner#1345): nodes, wiring, inputs and
 * follow-up steps anchored on one generate node, which a reader picks in a
 * generate panel and the agent may propose. Each generate node fixes its own
 * mode, model and params. Its prompt is interface text in the locale files,
 * `canvas.template.<id>.prompt` for the anchor and
 * `canvas.template.<id>.node.<key>.prompt` for the others, with the places the
 * reader acts on written as the proposal marks: `[📎 …]` for material to @,
 * `{✏️ …}` for words to fill in. What to put in an input is its
 * `canvas.template.<id>.input.<key>.note`.
 *
 * The mode, model, ratio and wording of the two image templates come from real
 * runs on Nano Banana Pro Ultra: a fixed ratio keeps the reference's own frame
 * and background out of the result, and the costume sheet needs the
 * photographic style and the hairstyle named or it drifts.
 *
 * Each template serves one creative goal (inner#1807): the panel lists goals
 * first and a goal's templates in a submenu, and the agent reads each
 * template's goal and triggers to offer it when the reader asks for it or
 * has not yet seen they need it.
 *
 * Each template is defined in a file of its own under `canvas/templates/`;
 * this module holds the shape and the registry they are collected into.
 */

import { CHARACTER_BIBLE } from "@shared/canvas/templates/character-bible.js";
import { CHARACTER_DESIGN_FROM_TEXT } from "@shared/canvas/templates/character-design-from-text.js";
import { CHARACTER_SHOWCASE_ORBIT } from "@shared/canvas/templates/character-showcase-orbit.js";
import { COSTUME_SHEET } from "@shared/canvas/templates/costume-sheet.js";
import { EXPRESSION_SHEET } from "@shared/canvas/templates/expression-sheet.js";
import { IDENTITY_LOCKED_SEQUENCE } from "@shared/canvas/templates/identity-locked-sequence.js";
import { SINGLE_VIEW_REFS_SCENE } from "@shared/canvas/templates/single-view-refs-scene.js";
import { STORYBOARD_GRID_25 } from "@shared/canvas/templates/storyboard-grid-25.js";
import type { GenerationNodeType } from "@shared/types/model-catalog.js";

/** Every creative goal, in the order the panels list them; its name is `canvas.template.goal.<goal>`. */
export const TEMPLATE_GOALS = ["character", "comics-storyboards"] as const;

/** A creative goal a template serves; the panel groups templates under it. */
export type TemplateGoal = (typeof TEMPLATE_GOALS)[number];

/** When the agent offers a template, in the words it reads. */
export interface TemplateTriggers {
  /** What a reader says when they ask for it outright. */
  asks: readonly string[];
  /** What the agent sees on the canvas or in the chat that makes it worth offering unasked. */
  offerWhen: readonly string[];
}

/** A template node's key: names its locale strings and lets marks point at it. */
export type TemplateNodeKey = string;

/** A node of the template that generates. */
export interface TemplateGenerateNode {
  key: TemplateNodeKey;
  role: "generate";
  type: GenerationNodeType;
  /** A mode of `config/models/modes.yaml`. */
  mode: string;
  /** A model name of the catalog. */
  model: string;
  /** Only the params the template fixes. */
  params: Readonly<Record<string, unknown>>;
}

/** A node of the template that holds a file we host. */
export interface TemplateResourceNode {
  key: TemplateNodeKey;
  role: "source";
  type: GenerationNodeType;
  /** Path under the hosted-resources address: `templates/<template id>/<file>`. */
  resource: string;
}

/** Material the reader supplies. */
export interface TemplateInput {
  key: string;
  type: GenerationNodeType;
  /** The generate nodes whose pool it is wired into; the anchor when left out. */
  feeds?: readonly TemplateNodeKey[];
}

/** Wiring between two template nodes, `into` as in a proposal edge. */
export interface TemplateEdge {
  from: TemplateNodeKey;
  to: TemplateNodeKey;
  into?: string;
}

/** One template: the nodes and wiring a reader or the agent starts a flow from. */
export interface GenerationTemplate {
  /** Stable id: the panel, the agent and the locale keys name it by this. */
  id: string;
  /** The generate node the panel applies the template to; every other node is upstream of it. */
  anchor: TemplateNodeKey;
  nodes: readonly (TemplateGenerateNode | TemplateResourceNode)[];
  edges: readonly TemplateEdge[];
  inputs: readonly TemplateInput[];
  /** Keys of the follow-up steps the reader does by hand once the anchor has generated; listed in the guide text node. */
  steps: readonly string[];
  /** What it makes and what it is for, in the words the agent reads. */
  agentNote: string;
  /** The creative goal it serves. */
  goal: TemplateGoal;
  /** When the agent offers it. */
  triggers: TemplateTriggers;
}

/** Every template, in the order the panels list them within a goal. */
export const GENERATION_TEMPLATES: readonly GenerationTemplate[] = [
  COSTUME_SHEET,
  CHARACTER_BIBLE,
  EXPRESSION_SHEET,
  CHARACTER_DESIGN_FROM_TEXT,
  SINGLE_VIEW_REFS_SCENE,
  IDENTITY_LOCKED_SEQUENCE,
  CHARACTER_SHOWCASE_ORBIT,
  STORYBOARD_GRID_25,
];

/**
 * The generate node a template is applied to.
 * @param template - The template.
 * @returns Its anchor node.
 * @throws {Error} When the anchor names no generate node, which the registry test rules out.
 */
export function templateAnchor(template: GenerationTemplate): TemplateGenerateNode {
  const anchor = template.nodes.find((node) => node.key === template.anchor);
  if (anchor?.role !== "generate") throw new Error(`template ${template.id} has no generate anchor`);
  return anchor;
}

/**
 * The templates a generate panel lists: those anchored on its node type.
 * @param nodeType - The panel's node type.
 * @returns Its templates, possibly none.
 * @throws {never} Never for a registry the registry test passes.
 */
export function templatesFor(nodeType: GenerationNodeType): readonly GenerationTemplate[] {
  return GENERATION_TEMPLATES.filter((template) => templateAnchor(template).type === nodeType);
}

/**
 * The templates a generate panel lists, grouped under their goals.
 * @param nodeType - The panel's node type.
 * @returns Each goal with its templates for that type, in goal order; goals with none are left out.
 * @throws {never} Never for a registry the registry test passes.
 */
export function templateGoalsFor(nodeType: GenerationNodeType): readonly { goal: TemplateGoal; templates: readonly GenerationTemplate[] }[] {
  const templates = templatesFor(nodeType);
  return TEMPLATE_GOALS.flatMap((goal) => {
    const held = templates.filter((template) => template.goal === goal);
    return held.length === 0 ? [] : [{ goal, templates: held }];
  });
}
