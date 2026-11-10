// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Generation templates (inner#977, inner#1345): nodes, wiring, inputs and
 * follow-up steps anchored on one generate node, which a user picks in a
 * generate panel and the agent may propose. Each generate node fixes its own
 * mode, model and params. Its prompt is interface text in the locale files,
 * `canvas.template.<id>.prompt` for the anchor and
 * `canvas.template.<id>.node.<key>.prompt` for the others (a node with shots
 * has `shot.<n>` in place of `prompt`), with the places the
 * user acts on written as the proposal marks: `[📎 …]` for material to @,
 * `{✏️ …}` for words to fill in. What to put in an input is its
 * `canvas.template.<id>.input.<key>.note`.
 *
 * The mode, model, ratio and wording of the storyboard and costume sheet
 * templates come from real runs on Nano Banana Pro Ultra: a fixed ratio keeps the reference's own frame
 * and background out of the result, and the costume sheet needs the
 * photographic style and the hairstyle named or it drifts.
 *
 * Each template serves one creative goal (inner#1807): the panel lists goals
 * first and a goal's templates in a submenu, and the agent reads each
 * template's goal and triggers to offer it when the user asks for it or
 * has not yet seen they need it.
 *
 * Each template is defined in a file of its own under `canvas/templates/`;
 * this module holds the shape and the registry they are collected into.
 */

import { BEAT_SYNC_OUTFIT_CHANGE } from "@shared/canvas/templates/beat-sync-outfit-change.js";
import { BULLET_TIME_MISHAP } from "@shared/canvas/templates/bullet-time-mishap.js";
import { CARRIED_OBJECT_TRANSITION } from "@shared/canvas/templates/carried-object-transition.js";
import { CHARACTER_BIBLE } from "@shared/canvas/templates/character-bible.js";
import { CHARACTER_DESIGN_FROM_TEXT } from "@shared/canvas/templates/character-design-from-text.js";
import { CHARACTER_SHOWCASE_ORBIT } from "@shared/canvas/templates/character-showcase-orbit.js";
import { COSTUME_SHEET } from "@shared/canvas/templates/costume-sheet.js";
import { EXPRESSION_SHEET } from "@shared/canvas/templates/expression-sheet.js";
import { FISHEYE_CLONE_POV } from "@shared/canvas/templates/fisheye-clone-pov.js";
import { FLASH_PHOTO_DUMP_GRID } from "@shared/canvas/templates/flash-photo-dump-grid.js";
import { GAME_UI_LIVESTREAM } from "@shared/canvas/templates/game-ui-livestream.js";
import { IDENTITY_LOCKED_SEQUENCE } from "@shared/canvas/templates/identity-locked-sequence.js";
import { PET_SELFIE_VLOG } from "@shared/canvas/templates/pet-selfie-vlog.js";
import { PHONE_VLOG_REALISM } from "@shared/canvas/templates/phone-vlog-realism.js";
import { POV_CONTINUOUS_SHOT } from "@shared/canvas/templates/pov-continuous-shot.js";
import { RETRO_FOUND_FOOTAGE } from "@shared/canvas/templates/retro-found-footage.js";
import { SINGLE_VIEW_REFS_SCENE } from "@shared/canvas/templates/single-view-refs-scene.js";
import { STORYBOARD_GRID_25 } from "@shared/canvas/templates/storyboard-grid-25.js";
import { TIME_FREEZE_REWIND } from "@shared/canvas/templates/time-freeze-rewind.js";
import { TRAVEL_CITY_WALK } from "@shared/canvas/templates/travel-city-walk.js";
import { TWIST_COMEDY_SKIT } from "@shared/canvas/templates/twist-comedy-skit.js";
import { VERTICAL_15S_QUICK_TIP } from "@shared/canvas/templates/vertical-15s-quick-tip.js";
import type { GenerationNodeType } from "@shared/types/model-catalog.js";

/** Every creative goal, in the order the panels list them; its name is `canvas.template.goal.<goal>`. */
export const TEMPLATE_GOALS = ["character", "comics-storyboards", "social-hooks", "sound"] as const;

/** A creative goal a template serves; the panel groups templates under it. */
export type TemplateGoal = (typeof TEMPLATE_GOALS)[number];

/** Where a template fits, in the words the agent reads; when to propose it is the working rules' call. */
export interface TemplateTriggers {
  /** What a user says when they ask for it outright. */
  asks: readonly string[];
  /** Situations it also fits beyond being asked for; none for a template only offered when asked for. */
  offerWhen: readonly string[];
}

/** One shot of a template generate node in the multi_shot mode; its words are `…shot.<n>` in the locale, counted from 1. */
export interface TemplateShot {
  /** Whole seconds. */
  seconds: number;
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
  /** The shots it generates, in order: given in the multi_shot mode only, where they stand in for the prompt. */
  shots?: readonly TemplateShot[];
}

/** A node of the template that holds a file we host. */
export interface TemplateResourceNode {
  key: TemplateNodeKey;
  role: "source";
  type: GenerationNodeType;
  /** Path under the hosted-resources address: `templates/<template id>/<file>`. */
  resource: string;
}

/** Material the user supplies. */
export interface TemplateInput {
  key: string;
  type: GenerationNodeType;
  /** The generate nodes whose pool it is wired into; the anchor when left out. */
  feeds?: readonly TemplateNodeKey[];
  /**
   * The slot param of the one node it feeds that it is wired into in place of
   * the pool (inner#1825): a slot that node's model declares in its mode for
   * the input's type, filled from the canvas. Not in the pool, so no prompt
   * marks it.
   */
  into?: string;
}

/** Wiring between two template nodes, `into` as in a proposal edge. */
export interface TemplateEdge {
  from: TemplateNodeKey;
  to: TemplateNodeKey;
  into?: string;
}

/** One template: the nodes and wiring a user or the agent starts a flow from. */
export interface GenerationTemplate {
  /** Stable id: the panel, the agent and the locale keys name it by this. */
  id: string;
  /**
   * The generate node the panel applies the template to. The template is a
   * graph with no circle around it, and every other node is one of three
   * (inner#1825): upstream of it, reaching it along template edges;
   * downstream of it, reached from it along template edges; or standalone,
   * touched by no template edge and tied to its instance by the anchor its
   * tag names.
   */
  anchor: TemplateNodeKey;
  nodes: readonly (TemplateGenerateNode | TemplateResourceNode)[];
  edges: readonly TemplateEdge[];
  inputs: readonly TemplateInput[];
  /** Keys of the follow-up steps the user does by hand once the anchor has generated; listed in the guide text node. */
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
  PET_SELFIE_VLOG,
  PHONE_VLOG_REALISM,
  RETRO_FOUND_FOOTAGE,
  TIME_FREEZE_REWIND,
  BULLET_TIME_MISHAP,
  BEAT_SYNC_OUTFIT_CHANGE,
  POV_CONTINUOUS_SHOT,
  CARRIED_OBJECT_TRANSITION,
  FISHEYE_CLONE_POV,
  FLASH_PHOTO_DUMP_GRID,
  GAME_UI_LIVESTREAM,
  TRAVEL_CITY_WALK,
  TWIST_COMEDY_SKIT,
  VERTICAL_15S_QUICK_TIP,
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

/** Where a template's generate node keeps its words: keys under the template's `canvas.template.<id>.` entry. */
export type TemplateNodeWords = { prompt: string } | { shots: ReadonlyArray<{ seconds: number; key: string }> };

/**
 * Where one of a template's generate nodes keeps its words: its prompt, or,
 * for a node with a shot list, one key per shot in place of a prompt.
 * @param template - The template.
 * @param key - The node's key.
 * @returns The keys under the template's locale entry.
 * @throws {never} Never.
 */
export function templateNodeWords(template: GenerationTemplate, key: TemplateNodeKey): TemplateNodeWords {
  const node = template.nodes.find((one) => one.key === key);
  const own = key === template.anchor ? "" : `node.${key}.`;
  const shots = node?.role === "generate" ? node.shots : undefined;
  if (shots === undefined) return { prompt: `${own}prompt` };
  return { shots: shots.map((shot, i) => ({ seconds: shot.seconds, key: `${own}shot.${String(i + 1)}` })) };
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
