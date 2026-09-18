// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every declaration in the catalog has something in the panel that acts on it,
 * and every name the panel acts on is declared (#269).
 *
 * How a parameter gets filled is now the model's to say, in one word per
 * parameter. Drawing it is still the panel's: what the slot is called, which
 * icon it carries, which sentence it refuses with. So a seam runs between the
 * yaml and the code, and a declaration on the wrong side of it fails quietly —
 * a param declaring `fill: canvas` with no slot leaves a reader unable to
 * supply material the run needs, and a param declaring `fill: none` while a
 * control is mounted says the run drops a value the reader just set.
 *
 * Twelve cases below make each of those a named failure. Seven read the model
 * layer, one reads back the other way, one reads the translations, and three
 * read the mode layer.
 *
 * They read the yaml as written, NOT `getModelCatalog()`: that projection
 * drops every model whose provider key is unset, so under CI it is empty and
 * a walk over it would pass by having nothing to walk.
 *
 * Scope: a claim belongs to a generation NODE, so a model is asked about only
 * through the nodes that offer it — its bucket, and a mode that node's picker
 * shows. A model no panel reaches (mini-tool operations, the three_d and
 * understand buckets) has an empty claim set, which is the right answer: there
 * is no panel to draw anything for it, so every one of its params has to say
 * `none`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  GENERATION_NODE_BUCKETS,
  GENERATION_NODE_MODES,
  PANEL_EDITOR_PARAM,
  REFERENCE_POOL_PARAM,
} from '@breatic/shared';
import type { GenerationNodeType } from '@breatic/shared';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import { PARAMS as AUDIO_PARAMS } from '@web/spaces/canvas/generate/audio-params';
import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { CAMERA_PARAMS } from '@web/spaces/canvas/generate/CameraPicker';
import { IMAGE_MODE_OPTIONS } from '@web/spaces/canvas/generate/image-mode-selection';
import { IMAGE_SLOTS } from '@web/spaces/canvas/generate/image-slots';
import { RATIO_RESOLUTION_PARAMS } from '@web/spaces/canvas/generate/RatioResolutionPicker';
import {
  slotsForMode,
  VIDEO_MODE_OPTIONS,
} from '@web/spaces/canvas/generate/video-mode-options';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import { EDITED_PARAMS } from '@web/spaces/canvas/generate/VideoParamsPicker';

// Both live at the repository root, which is two levels above this package.
// A wrong path here throws ENOENT naming it, rather than walking nothing and
// reporting clean.

/** Where the declarations live. */
const CONFIG = resolve(process.cwd(), '../../config/models');

/** Where the translations live. */
const LOCALES = resolve(process.cwd(), '../../locales');

/** The locales the product ships. */
const LOCALE_FILES = ['en.json', 'ja.json', 'ko.json', 'zh-CN.json', 'zh-TW.json'];

/** What one model declares about one of its parameters. */
interface ParamDeclaration {
  /** Who fills it: canvas, pool, editor, panel, remote, none. */
  fill?: unknown;
  /** The node kind it takes, when something points at a node to fill it. */
  accepts?: unknown;
  /** Whether a run may go without it. */
  optional?: unknown;
  /** The modes of this model it applies to; absent means all of them. */
  modes?: unknown;
  /** Why it has no control, required of every `fill: none`. */
  note?: unknown;
  /** The endpoint a remotely-filled param takes its choices from. */
  remote_source?: unknown;
  /** What has to hold before this one counts, in whichever of three ways. */
  when?: { source?: string; flag_on?: string; flag_off?: string };
}

/** One model as its yaml declares it. */
interface DeclaredModel {
  /** The catalog directory it came from. */
  bucket: string;
  /** The name a task names. */
  name: string;
  /** The modes it serves. */
  modes: string[];
  /** Its parameters, by name. */
  params: Record<string, ParamDeclaration>;
  /** Where to look, when this model is the one at fault. */
  file: string;
}

/** What one mode declares. */
interface DeclaredMode {
  /** The kinds of node a reader has to point at. */
  sources: string[];
  /** The name every answer about this mode calls it by. */
  label: string;
}

/**
 * Reads a bucket's model yaml files.
 * @param bucket - The directory name under `config/models`.
 * @returns Every model those files declare.
 */
function readBucket(bucket: string): DeclaredModel[] {
  const found: DeclaredModel[] = [];
  for (const file of readdirSync(`${CONFIG}/${bucket}`)) {
    if (!file.endsWith('.yaml') || file === 'providers.yaml') continue;
    const doc: unknown = parse(readFileSync(`${CONFIG}/${bucket}/${file}`, 'utf8'));
    const models = (doc as { models?: unknown })?.models;
    if (!Array.isArray(models)) continue;
    for (const model of models as Array<Record<string, unknown>>) {
      found.push({
        bucket,
        name: String(model.name),
        modes: Array.isArray(model.mode) ? model.mode.map(String) : [String(model.mode)],
        params: (model.params ?? {}) as Record<string, ParamDeclaration>,
        file: `config/models/${bucket}/${file}`,
      });
    }
  }
  return found;
}

/**
 * Every model the catalog declares, in every bucket.
 * @returns Those models.
 */
function everyModel(): DeclaredModel[] {
  const buckets = readdirSync(CONFIG, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return buckets.flatMap(readBucket);
}

/**
 * Every mode `modes.yaml` declares, keyed `bucket.mode`.
 * @returns Those modes.
 */
function everyMode(): Map<string, DeclaredMode> {
  const doc = parse(readFileSync(`${CONFIG}/modes.yaml`, 'utf8')) as Record<
    string,
    { modes?: Record<string, { sources?: unknown; label?: unknown }> }
  >;
  const found = new Map<string, DeclaredMode>();
  for (const [bucket, section] of Object.entries(doc)) {
    for (const [mode, declared] of Object.entries(section.modes ?? {})) {
      found.set(`${bucket}.${mode}`, {
        sources: Array.isArray(declared.sources) ? declared.sources.map(String) : [],
        label: typeof declared.label === 'string' ? declared.label : '',
      });
    }
  }
  return found;
}

/** Read once: every case below walks the whole catalog. */
const MODELS = everyModel();

/**
 * What each generation panel draws, derived from the panels' own definitions.
 *
 * Slots are asked per mode, because that is how a panel decides them: the
 * video toolbar draws two slots carrying `image` and two carrying `video`, and
 * which one a mode shows is the panel's own table. Asked without a mode, a
 * param claimed by any mode of the panel reads as claimed in all of them, and
 * a slot a mode never draws counts as drawn.
 */
const PANEL: Readonly<
  Record<
    GenerationNodeType,
    { slots: (mode: string) => readonly string[]; controls: readonly string[] }
  >
> = {
  image: {
    // One slot, offered in every image mode.
    slots: () => Object.values(IMAGE_SLOTS).map((spec) => spec.param),
    controls: [...RATIO_RESOLUTION_PARAMS, ...CAMERA_PARAMS],
  },
  video: {
    slots: (mode) => slotsForMode(mode).map((slot) => VIDEO_SLOTS[slot].param),
    controls: [...EDITED_PARAMS],
  },
  audio: {
    // One param per slot here, so every audio mode reaches all of them and
    // which ones a model actually offers is its own declaration's business.
    slots: () => Object.values(AUDIO_SLOTS).map((spec) => spec.param),
    controls: Object.keys(AUDIO_PARAMS),
  },
};

/**
 * The nodes whose picker offers this model.
 * @param model - The model being asked about.
 * @returns Those node types, empty when no panel reaches it.
 */
function nodesOffering(model: DeclaredModel): GenerationNodeType[] {
  const types = Object.keys(GENERATION_NODE_BUCKETS) as GenerationNodeType[];
  return types.filter(
    (node) =>
      GENERATION_NODE_BUCKETS[node].includes(model.bucket as 'image') &&
      model.modes.some((mode) => GENERATION_NODE_MODES[node].includes(mode)),
  );
}

/**
 * Everything a panel would act on for one model in one of its modes.
 *
 * A slot is drawn by a mode, so the answer is per mode: a model declaring a
 * first frame under a mode whose toolbar collects only a reference clip has
 * nowhere to put it, and asking across all its modes at once would not see
 * that.
 * @param model - The model being asked about.
 * @param mode - One of the modes it serves.
 * @returns The params a panel would draw for it there.
 */
function claimsFor(
  model: DeclaredModel,
  mode: string,
): { slots: Set<string>; controls: Set<string> } {
  const slots = new Set<string>();
  const controls = new Set<string>();
  for (const node of nodesOffering(model)) {
    if (!GENERATION_NODE_MODES[node].includes(mode)) continue;
    for (const param of PANEL[node].slots(mode)) slots.add(param);
    for (const param of PANEL[node].controls) controls.add(param);
  }
  return { slots, controls };
}

/**
 * The modes of this model a generation node's picker offers.
 * @param model - The model being asked about.
 * @returns Those modes; empty when no panel reaches it.
 */
function offeredModes(model: DeclaredModel): string[] {
  const nodes = nodesOffering(model);
  return model.modes.filter((mode) =>
    nodes.some((node) => GENERATION_NODE_MODES[node].includes(mode)),
  );
}

/**
 * Whether any mode this model is offered under draws that param as a slot.
 * @param model - The model being asked about.
 * @param param - The parameter name.
 * @returns True when at least one offered mode draws a slot for it.
 */
function someModeDrawsSlot(model: DeclaredModel, param: string): boolean {
  return offeredModes(model).some((mode) => claimsFor(model, mode).slots.has(param));
}

/**
 * Whether every mode this param applies to draws a slot for it.
 *
 * `modes` narrows a param to some of the model's own; absent means all of
 * them. A model reached by no panel has none of them offered, which is the
 * empty-set answer the `fill: none` case below relies on.
 * @param model - The model being asked about.
 * @param param - The parameter name.
 * @param spec - Its declaration, read for the modes it narrows to.
 * @returns The offered modes that draw no slot for it.
 */
function modesWithNoSlot(
  model: DeclaredModel,
  param: string,
  spec: ParamDeclaration,
): string[] {
  // The yaml is read leniently here, so `modes` is whatever was written: only
  // a list of strings narrows anything, and everything else means all of them.
  const narrowed = Array.isArray(spec.modes) ? spec.modes.map(String) : undefined;
  return offeredModes(model)
    .filter((mode) => narrowed === undefined || narrowed.includes(mode))
    .filter((mode) => !claimsFor(model, mode).slots.has(param));
}

/**
 * Walks every declared parameter, keeping the ones a predicate objects to.
 *
 * Every fill but `none` names something the panel does, so each of them rests
 * on the same premise: a panel reaches this model. That premise is answered
 * here rather than inside each case, because a case that forgets to ask it
 * passes by having nothing to walk — the model offers no modes, so a walk over
 * them agrees with anything.
 * @param fill - The `fill` value this walk is about.
 * @param objection - What is wrong with this declaration, or null when nothing is.
 * @returns One line per objection, naming the model and the param.
 */
function objections(
  fill: string,
  objection: (
    model: DeclaredModel,
    param: string,
    spec: ParamDeclaration,
  ) => string | null,
): string[] {
  const found: string[] = [];
  for (const model of MODELS) {
    const unreached = fill !== 'none' && nodesOffering(model).length === 0;
    for (const [param, spec] of Object.entries(model.params)) {
      if (spec?.fill !== fill) continue;
      const wrong = unreached
        ? `declares fill: ${fill} while no generation panel reaches this model, so nothing acts on it and it has to say none`
        : objection(model, param, spec);
      if (wrong !== null) found.push(`${model.file} ${model.name}.${param}: ${wrong}`);
    }
  }
  return found;
}

describe('what the catalog declares', () => {
  it('gives every canvas-filled param a slot in every mode that offers it', () => {
    expect(
      objections('canvas', (model, param, spec) => {
        const blind = modesWithNoSlot(model, param, spec);
        return blind.length === 0
          ? null
          : `declares fill: canvas and ${blind.join(', ')} draws no slot for it, so nothing can put material there`;
      }),
    ).toEqual([]);
  });

  it('takes the same kind of node in the slot as in the declaration', () => {
    // Two readers answer "which kind of node goes here": the canvas highlights
    // candidates and writes the pick off the slot's own entry, while the
    // enqueue gate reads the declaration. A slot drawn for one kind and
    // declared for another lights up a node the run then sends to a vendor
    // that cannot take it.
    // Every slot drawing that param, not one of them: two video slots carry
    // `image` and two carry `video`, so a map keyed by the param name would
    // keep the last one written and hide a disagreement between them. The
    // image panel's one slot states no kind — it is drawn for pictures and
    // nothing else — so there is nothing of its to disagree with.
    const slotSpecs = [VIDEO_SLOTS, AUDIO_SLOTS].flatMap((registry) =>
      Object.values(registry),
    );
    expect(
      objections('canvas', (_model, param, spec) => {
        const apart = slotSpecs
          .filter((slot) => slot.param === param && slot.accepts !== spec.accepts)
          .map((slot) => `${slot.testId} takes ${slot.accepts}`);
        return apart.length === 0
          ? null
          : `declares accepts: ${String(spec.accepts)} while ${apart.join(', ')}`;
      }),
    ).toEqual([]);
  });

  it('spells every pool-filled param the way the reference pool is read', () => {
    expect(
      objections('pool', (_model, param) =>
        param === REFERENCE_POOL_PARAM
          ? null
          : `declares fill: pool while the pool travels as '${REFERENCE_POOL_PARAM}', so the references a reader adds reach the run under a name this model never declared`,
      ),
    ).toEqual([]);
  });

  it('spells every editor-filled param the way the panel names its text box', () => {
    expect(
      objections('editor', (_model, param) =>
        param === PANEL_EDITOR_PARAM
          ? null
          : `declares fill: editor while the panel's own box writes '${PANEL_EDITOR_PARAM}', so what a reader types reaches the run under a name this model never declared`,
      ),
    ).toEqual([]);
  });

  it('lets a reader satisfy every condition a param waits on', () => {
    const found: string[] = [];
    for (const model of MODELS) {
      for (const [param, spec] of Object.entries(model.params)) {
        const gate = spec?.when;
        for (const named of [gate?.source, gate?.flag_on, gate?.flag_off]) {
          // The loader already refuses a gate naming a param this model does
          // not declare, so what is left to ask is whether the reader can do
          // anything about the one it names. A gate on a param with no
          // control of its own never opens, and the control it guards is
          // then declared and unreachable at once.
          if (named === undefined) continue;
          if (model.params[named]?.fill !== 'none') continue;
          found.push(
            `${model.file} ${model.name}.${param}: waits on '${named}', which declares fill: none, so nothing a reader does opens this control`,
          );
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('gives every panel- and remote-filled param a control', () => {
    const drawn = objections('panel', (model, param) =>
      // Controls do not vary by mode: the pickers offer whatever the model
      // declares, so one offered mode answering for all of them is right here.
      offeredModes(model).some((mode) => claimsFor(model, mode).controls.has(param))
        ? null
        : 'declares fill: panel and no panel draws a control for it, so a reader cannot set it',
    );
    // The voice picker finds its param by this marker rather than by name, so
    // the two tts models spell the same choice differently and both are drawn.
    const remote = objections('remote', (_model, _param, spec) =>
      spec.remote_source === 'voices'
        ? null
        : 'declares fill: remote without remote_source: voices, and the voice picker locates its param by that marker alone',
    );
    expect([...drawn, ...remote]).toEqual([]);
  });

  it('leaves every param that says it has no control unclaimed, and says why', () => {
    const claimed = objections('none', (model, param) => {
      // Claimed by ANY offered mode is enough to object: a param saying it has
      // no control while one mode draws one still drops what a reader sets
      // there.
      if (someModeDrawsSlot(model, param)) {
        return 'declares fill: none while the panel draws a slot under that name, so material a reader picks is dropped';
      }
      if (offeredModes(model).some((mode) => claimsFor(model, mode).controls.has(param))) {
        return 'declares fill: none while the panel draws a control under that name, so a value a reader sets is dropped';
      }
      if (param === REFERENCE_POOL_PARAM && nodesOffering(model).length > 0) {
        return 'declares fill: none under the reference pool\'s own name, so references a reader adds are dropped';
      }
      return null;
    });
    // The reason travels with the param. A central list of them sat far from
    // what it described, and a line saying "no control" after one was built is
    // exactly why nobody noticed the control was missing.
    const unexplained = objections('none', (_model, _param, spec) =>
      typeof spec.note === 'string' && spec.note.length > 0
        ? null
        : 'declares fill: none with no note saying why it has none',
    );
    expect([...claimed, ...unexplained]).toEqual([]);
  });

  it('declares every param the panels point at', () => {
    const missing: string[] = [];
    for (const node of Object.keys(PANEL) as GenerationNodeType[]) {
      const reachable = MODELS.filter((model) => nodesOffering(model).includes(node));
      // Every slot this panel draws anywhere, across all the modes it offers:
      // the question here is whether anything declares the name, not which
      // mode shows it.
      const slots = GENERATION_NODE_MODES[node].flatMap((mode) => PANEL[node].slots(mode));
      for (const param of [...new Set(slots), ...PANEL[node].controls]) {
        if (!reachable.some((model) => param in model.params)) {
          missing.push(
            `the ${node} panel draws '${param}' and no model it offers declares it, so that slot or control is mounted for nobody`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('calls every mode what its picker prints', () => {
    // The mode code is nowhere on screen: the picker renders this string and
    // nothing else, and `canvas_capabilities` and the skill prompts quote the
    // declared one. Two names for one mode sends a reader looking through the
    // picker for a row that says what the agent said.
    const declaredModes = everyMode();
    const drawn = [
      ...IMAGE_MODE_OPTIONS.map((o) => ['image', o.value, o.label] as const),
      ...VIDEO_MODE_OPTIONS.map((o) => ['video', o.value, o.label] as const),
      // The audio node's picker spans two buckets, so each of its rows is
      // looked up under whichever declares that mode.
      ...AUDIO_MODE_OPTIONS.map((o) => ['audio', o.value, o.label] as const),
    ];
    const apart: string[] = [];
    for (const [node, mode, printed] of drawn) {
      const declared = GENERATION_NODE_BUCKETS[node as GenerationNodeType]
        .map((bucket) => declaredModes.get(`${bucket}.${mode}`))
        .find((found) => found !== undefined);
      if (declared === undefined) {
        apart.push(`the ${node} picker offers '${mode}', which modes.yaml does not declare`);
        continue;
      }
      if (declared.label !== printed) {
        apart.push(
          `the ${node} picker prints '${printed}' for '${mode}' while modes.yaml calls it '${declared.label}'`,
        );
      }
    }
    expect(apart).toEqual([]);
  });

  it('has every slot sentence in all five locales', () => {
    const catalogs = LOCALE_FILES.map((file) => ({
      file,
      messages: JSON.parse(readFileSync(`${LOCALES}/${file}`, 'utf8')) as unknown,
    }));
    // `errorKey` only on a slot whose panel words its refusal from the slot,
    // so the widened shape carries it as optional and an absent one is not a
    // key to look for.
    const slots: ReadonlyArray<{
      labelKey: string;
      tipKey: string;
      clearLabelKey: string;
      errorKey?: string;
    }> = [
      ...Object.values(IMAGE_SLOTS),
      ...Object.values(VIDEO_SLOTS),
      ...Object.values(AUDIO_SLOTS),
    ];
    const keys = slots.flatMap((spec) =>
      [spec.labelKey, spec.tipKey, spec.clearLabelKey, spec.errorKey].filter(
        (key): key is string => typeof key === 'string',
      ),
    );
    expect(keys.length, 'the panels declare slots with sentences').toBeGreaterThan(0);

    const missing: string[] = [];
    for (const { file, messages } of catalogs) {
      for (const key of keys) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (node, part) =>
              node !== null && typeof node === 'object'
                ? (node as Record<string, unknown>)[part]
                : undefined,
            messages,
          );
        if (typeof value !== 'string' || value.length === 0) {
          missing.push(`locales/${file} has no '${key}', so that slot prints the raw key`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('has a model behind every mode, and a mode row behind every model', () => {
    const modes = everyMode();
    const orphanModes = [...modes.keys()].filter(
      (row) =>
        !MODELS.some(
          (model) => model.modes.some((mode) => `${model.bucket}.${mode}` === row),
        ),
    );
    const orphanModels = MODELS.flatMap((model) =>
      model.modes
        .filter((mode) => !modes.has(`${model.bucket}.${mode}`))
        .map((mode) => `${model.file} ${model.name} serves '${mode}', which modes.yaml has no row for`),
    );
    expect({ orphanModes, orphanModels }).toEqual({ orphanModes: [], orphanModels: [] });
  });

  it('has a param able to carry every source a mode needs, in every model serving it', () => {
    const modes = everyMode();
    const uncarried: string[] = [];
    for (const model of MODELS) {
      for (const mode of model.modes) {
        const declared = modes.get(`${model.bucket}.${mode}`);
        for (const source of declared?.sources ?? []) {
          const carrier = Object.entries(model.params).some(
            ([, spec]) =>
              spec?.accepts === source &&
              spec.optional !== true &&
              (!Array.isArray(spec.modes) || spec.modes.map(String).includes(mode)),
          );
          if (!carrier) {
            uncarried.push(
              `${model.file} ${model.name}.${mode} needs a ${source} and declares no param that accepts one, so the gate refuses every submission it makes`,
            );
          }
        }
      }
    }
    expect(uncarried).toEqual([]);
  });
});
