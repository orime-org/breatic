// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Generation templates (inner#977, inner#1345): nodes, wiring, inputs and
 * follow-up steps anchored on one generate node, which a user picks in a
 * generate panel and the agent may propose. Each generate node fixes its own
 * mode, model and params. Its prompt is interface text in the locale files,
 * `canvas.template.<id>.prompt` for the anchor and
 * `canvas.template.<id>.node.<key>.prompt` for the others (a node with shots
 * has `shot.<n>` in place of `prompt`, a node with dialogue lines `line.<n>`), with the places the
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

import { templateStyleKey, templateStylesOf, type TemplateStyleSetId } from "@shared/canvas/template-styles.js";
import { THREE_D_CARTOON_SHORT } from "@shared/canvas/templates/3d-cartoon-short.js";
import { AMBIENCE_SFX_BED } from "@shared/canvas/templates/ambience-sfx-bed.js";
import { ANIME_ACTION_CLIMAX } from "@shared/canvas/templates/anime-action-climax.js";
import { ANIME_OPENING_15S } from "@shared/canvas/templates/anime-opening-15s.js";
import { ANIME_SCENE } from "@shared/canvas/templates/anime-scene.js";
import { APP_LAUNCH_PROMO } from "@shared/canvas/templates/app-launch-promo.js";
import { BEAT_SYNC_OUTFIT_CHANGE } from "@shared/canvas/templates/beat-sync-outfit-change.js";
import { BEFORE_AFTER_REVEAL } from "@shared/canvas/templates/before-after-reveal.js";
import { BRAND_ORIGIN_FILM } from "@shared/canvas/templates/brand-origin-film.js";
import { BULLET_TIME_MISHAP } from "@shared/canvas/templates/bullet-time-mishap.js";
import { BULLET_TIME_MOMENT } from "@shared/canvas/templates/bullet-time-moment.js";
import { CARRIED_OBJECT_TRANSITION } from "@shared/canvas/templates/carried-object-transition.js";
import { CARTOON_GAG } from "@shared/canvas/templates/cartoon-gag.js";
import { CHARACTER_BIBLE } from "@shared/canvas/templates/character-bible.js";
import { CHARACTER_DESIGN_FROM_TEXT } from "@shared/canvas/templates/character-design-from-text.js";
import { CHARACTER_SHOWCASE_ORBIT } from "@shared/canvas/templates/character-showcase-orbit.js";
import { CINEMATIC_15S_ARC } from "@shared/canvas/templates/cinematic-15s-arc.js";
import { CLIP_AMBIENCE_FOLEY } from "@shared/canvas/templates/clip-ambience-foley.js";
import { COMIC_4KOMA } from "@shared/canvas/templates/comic-4koma.js";
import { COMIC_PAGE_TO_MOTION } from "@shared/canvas/templates/comic-page-to-motion.js";
import { COMIC_PAGE } from "@shared/canvas/templates/comic-page.js";
import { COMIC_PANELS_TO_SHOTS } from "@shared/canvas/templates/comic-panels-to-shots.js";
import { SCENE_PLATE } from "@shared/canvas/templates/scene-plate.js";
import { DRAMA_SINGLE_SCENE } from "@shared/canvas/templates/drama-single-scene.js";
import { SHORT_DRAMA_REVERSAL } from "@shared/canvas/templates/short-drama-reversal.js";
import { EMOTIONAL_DIALOGUE_TIMELINE } from "@shared/canvas/templates/emotional-dialogue-timeline.js";
import { HORROR_SUSPENSE } from "@shared/canvas/templates/horror-suspense.js";
import { SHORT_DRAMA_EPISODE } from "@shared/canvas/templates/short-drama-episode.js";
import { COSTUME_SHEET } from "@shared/canvas/templates/costume-sheet.js";
import { DAY_TO_NIGHT_EXTERIOR } from "@shared/canvas/templates/day-to-night-exterior.js";
import { DESTINATION_FESTIVAL_POSTER } from "@shared/canvas/templates/destination-festival-poster.js";
import { DISH_HERO_STILL } from "@shared/canvas/templates/dish-hero-still.js";
import { EPIC_FANTASY_SCIFI } from "@shared/canvas/templates/epic-fantasy-scifi.js";
import { ERA_WALKTHROUGH_MONTAGE } from "@shared/canvas/templates/era-walkthrough-montage.js";
import { EXPRESSION_SHEET } from "@shared/canvas/templates/expression-sheet.js";
import { EXTREME_SPORTS_RUN } from "@shared/canvas/templates/extreme-sports-run.js";
import { FASHION_LOOKBOOK } from "@shared/canvas/templates/fashion-lookbook.js";
import { FIGHT_DUEL_LOCKED } from "@shared/canvas/templates/fight-duel-locked.js";
import { FIGHT_DUEL_ONE_TAKE } from "@shared/canvas/templates/fight-duel-one-take.js";
import { FIGHT_EXCHANGE_SHORT } from "@shared/canvas/templates/fight-exchange-short.js";
import { FILM_STYLE_SHOT } from "@shared/canvas/templates/film-style-shot.js";
import { FILM_STYLE_STILL } from "@shared/canvas/templates/film-style-still.js";
import { FISHEYE_CLONE_POV } from "@shared/canvas/templates/fisheye-clone-pov.js";
import { FLASH_PHOTO_DUMP_GRID } from "@shared/canvas/templates/flash-photo-dump-grid.js";
import { FOOD_MONEY_SHOT } from "@shared/canvas/templates/food-money-shot.js";
import { GAME_UI_LIVESTREAM } from "@shared/canvas/templates/game-ui-livestream.js";
import { HERO_ORBIT_REVEAL } from "@shared/canvas/templates/hero-orbit-reveal.js";
import { HYPE_THEN_TWIST_AD } from "@shared/canvas/templates/hype-then-twist-ad.js";
import { IDENTITY_LOCKED_SEQUENCE } from "@shared/canvas/templates/identity-locked-sequence.js";
import { IMPACT_FRAME_HIT } from "@shared/canvas/templates/impact-frame-hit.js";
import { LANDSCAPE_3_SHOT } from "@shared/canvas/templates/landscape-3-shot.js";
import { LAUNCH_STORY_3_BEAT } from "@shared/canvas/templates/launch-story-3-beat.js";
import { LISTING_WALKTHROUGH_15S } from "@shared/canvas/templates/listing-walkthrough-15s.js";
import { LIVESTREAM_PITCH } from "@shared/canvas/templates/livestream-pitch.js";
import { LONG_FORM_ACTS } from "@shared/canvas/templates/long-form-acts.js";
import { LOOKBOOK_MULTI_LOOK } from "@shared/canvas/templates/lookbook-multi-look.js";
import { MUSIC_MOOD_FROM_IMAGE } from "@shared/canvas/templates/music-mood-from-image.js";
import { NAME_AS_WORLD_TYPOGRAPHY } from "@shared/canvas/templates/name-as-world-typography.js";
import { PET_SELFIE_VLOG } from "@shared/canvas/templates/pet-selfie-vlog.js";
import { PHONE_VLOG_REALISM } from "@shared/canvas/templates/phone-vlog-realism.js";
import { PHOTO_PAPER_DIORAMA } from "@shared/canvas/templates/photo-paper-diorama.js";
import { POV_CONTINUOUS_SHOT } from "@shared/canvas/templates/pov-continuous-shot.js";
import { PRODUCT_AD_15S } from "@shared/canvas/templates/product-ad-15s.js";
import { PRODUCT_COMMERCIAL_SHOTLIST } from "@shared/canvas/templates/product-commercial-shotlist.js";
import { PRODUCT_HERO_DIRECT_I2V } from "@shared/canvas/templates/product-hero-direct-i2v.js";
import { PRODUCT_HERO_MOTION } from "@shared/canvas/templates/product-hero-motion.js";
import { PRODUCT_HERO_STILL } from "@shared/canvas/templates/product-hero-still.js";
import { PRODUCT_PARTICLE_REVEAL } from "@shared/canvas/templates/product-particle-reveal.js";
import { PRODUCT_STATE_CHANGE } from "@shared/canvas/templates/product-state-change.js";
import { PRODUCT_TURNTABLE_360 } from "@shared/canvas/templates/product-turntable-360.js";
import { PROMO_FILM_ASSEMBLED } from "@shared/canvas/templates/promo-film-assembled.js";
import { PROPERTY_FULL_TOUR } from "@shared/canvas/templates/property-full-tour.js";
import { RECIPE_PROCESS_MONTAGE } from "@shared/canvas/templates/recipe-process-montage.js";
import { REFERENCE_VIDEO_REMIX } from "@shared/canvas/templates/reference-video-remix.js";
import { RENOVATION_BEFORE_AFTER } from "@shared/canvas/templates/renovation-before-after.js";
import { RETRO_FOUND_FOOTAGE } from "@shared/canvas/templates/retro-found-footage.js";
import { ROOM_STAGING_STILL } from "@shared/canvas/templates/room-staging-still.js";
import { SCORE_FOR_MY_VIDEO } from "@shared/canvas/templates/score-for-my-video.js";
import { SEAMLESS_BRIDGE } from "@shared/canvas/templates/seamless-bridge.js";
import { SECTION_MAPPED_SCORE } from "@shared/canvas/templates/section-mapped-score.js";
import { SINGLE_VIEW_REFS_SCENE } from "@shared/canvas/templates/single-view-refs-scene.js";
import { SONG_COVER } from "@shared/canvas/templates/song-cover.js";
import { SPACE_TOUR_SINGLE_TAKE } from "@shared/canvas/templates/space-tour-single-take.js";
import { SPORTS_LIVE_COVERAGE } from "@shared/canvas/templates/sports-live-coverage.js";
import { STOP_MOTION_SHORT } from "@shared/canvas/templates/stop-motion-short.js";
import { STORYBOARD_GRID_25 } from "@shared/canvas/templates/storyboard-grid-25.js";
import { STORYBOARD_SHEET_9 } from "@shared/canvas/templates/storyboard-sheet-9.js";
import { STORYBOARD_TO_VIDEO } from "@shared/canvas/templates/storyboard-to-video.js";
import { STYLE_SOUND_BED } from "@shared/canvas/templates/style-sound-bed.js";
import { TALKING_HEAD_PITCH } from "@shared/canvas/templates/talking-head-pitch.js";
import { TALKING_OWN_VOICE } from "@shared/canvas/templates/talking-own-voice.js";
import { TALKING_PRESENTER } from "@shared/canvas/templates/talking-presenter.js";
import { TIME_FREEZE_REWIND } from "@shared/canvas/templates/time-freeze-rewind.js";
import { TRAILER_BEAT_3_SHOT } from "@shared/canvas/templates/trailer-beat-3-shot.js";
import { TRANSFORMATION_6_SHOT } from "@shared/canvas/templates/transformation-6-shot.js";
import { TRAVEL_CITY_WALK } from "@shared/canvas/templates/travel-city-walk.js";
import { TRY_ON_STILL } from "@shared/canvas/templates/try-on-still.js";
import { TWIST_COMEDY_SKIT } from "@shared/canvas/templates/twist-comedy-skit.js";
import { TWO_SPEAKER_TALK } from "@shared/canvas/templates/two-speaker-talk.js";
import { TWO_VOICE_DIALOGUE } from "@shared/canvas/templates/two-voice-dialogue.js";
import { UGC_CREATOR_REVIEW } from "@shared/canvas/templates/ugc-creator-review.js";
import { UNBOXING_AD } from "@shared/canvas/templates/unboxing-ad.js";
import { UNDERSCORE_BGM } from "@shared/canvas/templates/underscore-bgm.js";
import { VARIANT_CAROUSEL_AD } from "@shared/canvas/templates/variant-carousel-ad.js";
import { VEHICLE_SPEED_CUTLIST } from "@shared/canvas/templates/vehicle-speed-cutlist.js";
import { VERTICAL_15S_QUICK_TIP } from "@shared/canvas/templates/vertical-15s-quick-tip.js";
import { VOICE_CLONE_LINE } from "@shared/canvas/templates/voice-clone-line.js";
import { VOICE_FROM_DESCRIPTOR } from "@shared/canvas/templates/voice-from-descriptor.js";
import { VOICE_LINE } from "@shared/canvas/templates/voice-line.js";
import type { GenerationNodeType } from "@shared/types/model-catalog.js";

/** Every creative goal, in the order the panels list them; its name is `canvas.template.goal.<goal>`. */
export const TEMPLATE_GOALS = ["character", "comics-storyboards", "drama", "fight", "animation", "ecommerce", "product-showcase", "promo", "food", "spaces", "fashion", "social-hooks", "talking", "posters", "film-styles", "cinematic", "speed", "sound", "video-remix"] as const;

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

/** One line of a dialogue node: who says it, numbered from 1 among the node's speakers. */
export interface TemplateLine {
  speaker: number;
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
  /**
   * The lines of a dialogue, in order: given on a model whose speakers stand
   * in for its voice, where they stand in for the prompt (inner#1825 design
   * 8.5). Each line's words are `line.<n>`, words only, no name in front.
   */
  lines?: readonly TemplateLine[];
  /**
   * The part of the picked style its prompt takes, one of its template's
   * style set's `parts` (inner#1817): the style's words for that part are
   * written after the node's own. Prompt nodes only.
   */
  styleWords?: string;
}

/** A node of the template that holds a file we host. */
export interface TemplateResourceNode {
  key: TemplateNodeKey;
  role: "source";
  type: GenerationNodeType;
  /** Path under the hosted-resources address: `templates/<template id>/<file>`. */
  resource: string;
}

/**
 * A node of the template that holds words the user keeps and edits: a script,
 * lyrics (inner#1824, CAP-3). Its words are `node.<key>.text` in the locale and
 * may carry fill-in marks, no reference mark and no note. It only starts
 * template edges, into the pool or the lyrics box of a generate node.
 */
export interface TemplateTextNode {
  key: TemplateNodeKey;
  role: "written";
  type: "text";
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
  /**
   * The user may leave it empty (inner#1811, CAP-9): every reference to it
   * stands in a paragraph of its own, which is not sent while its node holds
   * nothing. Only a pool input can be optional.
   */
  optional?: true;
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
  nodes: readonly (TemplateGenerateNode | TemplateResourceNode | TemplateTextNode)[];
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
  /** The style set the user picks one style from before it applies (inner#1817). */
  styles?: TemplateStyleSetId;
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
  STORYBOARD_SHEET_9,
  COMIC_PAGE,
  COMIC_4KOMA,
  STORYBOARD_TO_VIDEO,
  COMIC_PAGE_TO_MOTION,
  COMIC_PANELS_TO_SHOTS,
  SCENE_PLATE,
  DRAMA_SINGLE_SCENE,
  SHORT_DRAMA_REVERSAL,
  EMOTIONAL_DIALOGUE_TIMELINE,
  HORROR_SUSPENSE,
  SHORT_DRAMA_EPISODE,
  FIGHT_DUEL_ONE_TAKE,
  FIGHT_EXCHANGE_SHORT,
  FIGHT_DUEL_LOCKED,
  HERO_ORBIT_REVEAL,
  BULLET_TIME_MOMENT,
  IMPACT_FRAME_HIT,
  CARTOON_GAG,
  THREE_D_CARTOON_SHORT,
  STOP_MOTION_SHORT,
  ANIME_SCENE,
  ANIME_ACTION_CLIMAX,
  ANIME_OPENING_15S,
  PRODUCT_AD_15S,
  UGC_CREATOR_REVIEW,
  LIVESTREAM_PITCH,
  HYPE_THEN_TWIST_AD,
  PRODUCT_COMMERCIAL_SHOTLIST,
  UNBOXING_AD,
  VARIANT_CAROUSEL_AD,
  PRODUCT_HERO_STILL,
  PRODUCT_HERO_MOTION,
  PRODUCT_TURNTABLE_360,
  PRODUCT_PARTICLE_REVEAL,
  PRODUCT_HERO_DIRECT_I2V,
  PRODUCT_STATE_CHANGE,
  APP_LAUNCH_PROMO,
  BRAND_ORIGIN_FILM,
  LAUNCH_STORY_3_BEAT,
  PROMO_FILM_ASSEMBLED,
  FOOD_MONEY_SHOT,
  RECIPE_PROCESS_MONTAGE,
  DISH_HERO_STILL,
  SPACE_TOUR_SINGLE_TAKE,
  ROOM_STAGING_STILL,
  RENOVATION_BEFORE_AFTER,
  DAY_TO_NIGHT_EXTERIOR,
  BEFORE_AFTER_REVEAL,
  LISTING_WALKTHROUGH_15S,
  PROPERTY_FULL_TOUR,
  FASHION_LOOKBOOK,
  TRY_ON_STILL,
  LOOKBOOK_MULTI_LOOK,
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
  TALKING_PRESENTER,
  TALKING_HEAD_PITCH,
  TWO_SPEAKER_TALK,
  TALKING_OWN_VOICE,
  NAME_AS_WORLD_TYPOGRAPHY,
  DESTINATION_FESTIVAL_POSTER,
  PHOTO_PAPER_DIORAMA,
  FILM_STYLE_STILL,
  FILM_STYLE_SHOT,
  ERA_WALKTHROUGH_MONTAGE,
  STYLE_SOUND_BED,
  CINEMATIC_15S_ARC,
  LANDSCAPE_3_SHOT,
  EPIC_FANTASY_SCIFI,
  TRAILER_BEAT_3_SHOT,
  TRANSFORMATION_6_SHOT,
  LONG_FORM_ACTS,
  VEHICLE_SPEED_CUTLIST,
  SPORTS_LIVE_COVERAGE,
  EXTREME_SPORTS_RUN,
  AMBIENCE_SFX_BED,
  VOICE_LINE,
  TWO_VOICE_DIALOGUE,
  UNDERSCORE_BGM,
  VOICE_FROM_DESCRIPTOR,
  SONG_COVER,
  VOICE_CLONE_LINE,
  SCORE_FOR_MY_VIDEO,
  MUSIC_MOOD_FROM_IMAGE,
  CLIP_AMBIENCE_FOLEY,
  SECTION_MAPPED_SCORE,
  REFERENCE_VIDEO_REMIX,
  SEAMLESS_BRIDGE,
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

/** Where a template's generate or text node keeps its words: keys under the template's `canvas.template.<id>.` entry. */
export type TemplateNodeWords =
  | { prompt: string; styleKey?: string }
  | { text: string }
  | { shots: ReadonlyArray<{ seconds: number; key: string }> }
  | { lines: ReadonlyArray<{ speaker: number; key: string }> };

/**
 * Where one of a template's generate nodes keeps its words: its prompt, or,
 * for a node with a shot list or dialogue lines, one key per shot or line in
 * place of a prompt; a text node keeps them in its text.
 * A prompt node that takes a part of the template's style also gets the
 * absolute key of the picked style's words for it, written after its own.
 * @param template - The template.
 * @param key - The node's key.
 * @param style - The picked style, if any.
 * @returns The keys under the template's locale entry, and the style's absolute key.
 * @throws {never} Never.
 */
export function templateNodeWords(template: GenerationTemplate, key: TemplateNodeKey, style?: string): TemplateNodeWords {
  const node = template.nodes.find((one) => one.key === key);
  const own = key === template.anchor ? "" : `node.${key}.`;
  if (node?.role === "written") return { text: `${own}text` };
  const lines = node?.role === "generate" ? node.lines : undefined;
  if (lines !== undefined) return { lines: lines.map((line, i) => ({ speaker: line.speaker, key: `${own}line.${String(i + 1)}` })) };
  const shots = node?.role === "generate" ? node.shots : undefined;
  if (shots === undefined) {
    const part = node?.role === "generate" ? node.styleWords : undefined;
    const set = templateStylesOf(template);
    const held = set !== undefined && style !== undefined && set.styles.some((one) => one.id === style);
    return part !== undefined && held ? { prompt: `${own}prompt`, styleKey: templateStyleKey(set.id, style, part) } : { prompt: `${own}prompt` };
  }
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
