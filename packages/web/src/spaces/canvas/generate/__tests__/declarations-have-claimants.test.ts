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
 * Nine cases below make each of those a named failure. Six read the model
 * layer, one reads back the other way, one reads the translations, and two
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

import { PARAMS as AUDIO_PARAMS } from '@web/spaces/canvas/generate/audio-params';
import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { CAMERA_PARAMS } from '@web/spaces/canvas/generate/CameraPicker';
import { IMAGE_SLOTS } from '@web/spaces/canvas/generate/image-slots';
import { RATIO_RESOLUTION_PARAMS } from '@web/spaces/canvas/generate/RatioResolutionPicker';
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
    { modes?: Record<string, { sources?: unknown }> }
  >;
  const found = new Map<string, DeclaredMode>();
  for (const [bucket, section] of Object.entries(doc)) {
    for (const [mode, declared] of Object.entries(section.modes ?? {})) {
      found.set(`${bucket}.${mode}`, {
        sources: Array.isArray(declared.sources) ? declared.sources.map(String) : [],
      });
    }
  }
  return found;
}

/** Read once: every case below walks the whole catalog. */
const MODELS = everyModel();

/** What each generation panel draws, derived from the panels' own definitions. */
const PANEL: Readonly<
  Record<GenerationNodeType, { slots: readonly string[]; controls: readonly string[] }>
> = {
  image: {
    slots: Object.values(IMAGE_SLOTS).map((spec) => spec.param),
    controls: [...RATIO_RESOLUTION_PARAMS, ...CAMERA_PARAMS],
  },
  video: {
    slots: Object.values(VIDEO_SLOTS).map((spec) => spec.param),
    controls: [...EDITED_PARAMS],
  },
  audio: {
    slots: Object.values(AUDIO_SLOTS).map((spec) => spec.param),
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

/** Everything a panel would act on for one model: its slots and its controls. */
function claimsFor(model: DeclaredModel): { slots: Set<string>; controls: Set<string> } {
  const slots = new Set<string>();
  const controls = new Set<string>();
  for (const node of nodesOffering(model)) {
    for (const param of PANEL[node].slots) slots.add(param);
    for (const param of PANEL[node].controls) controls.add(param);
  }
  return { slots, controls };
}

/**
 * Walks every declared parameter, keeping the ones a predicate objects to.
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
    for (const [param, spec] of Object.entries(model.params)) {
      if (spec?.fill !== fill) continue;
      const wrong = objection(model, param, spec);
      if (wrong !== null) found.push(`${model.file} ${model.name}.${param}: ${wrong}`);
    }
  }
  return found;
}

describe('what the catalog declares', () => {
  it('gives every canvas-filled param a slot in the panel that offers it', () => {
    expect(
      objections('canvas', (model, param) =>
        claimsFor(model).slots.has(param)
          ? null
          : 'declares fill: canvas and no panel draws a slot for it, so nothing can put material there',
      ),
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

  it('gives every panel- and remote-filled param a control', () => {
    const drawn = objections('panel', (model, param) =>
      claimsFor(model).controls.has(param)
        ? null
        : 'declares fill: panel and no panel draws a control for it, so a reader cannot set it',
    );
    // The voice picker finds its param by this marker rather than by name, so
    // the two tts models spell the same choice differently and both are drawn.
    const remote = objections('remote', (model, _param, spec) =>
      spec.remote_source === 'voices' && nodesOffering(model).length > 0
        ? null
        : 'declares fill: remote without remote_source: voices on a model a panel offers, and the voice picker locates its param by that marker alone',
    );
    expect([...drawn, ...remote]).toEqual([]);
  });

  it('leaves every param that says it has no control unclaimed, and says why', () => {
    const claimed = objections('none', (model, param) => {
      const { slots, controls } = claimsFor(model);
      if (slots.has(param)) {
        return 'declares fill: none while the panel draws a slot under that name, so material a reader picks is dropped';
      }
      if (controls.has(param)) {
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
      for (const param of [...PANEL[node].slots, ...PANEL[node].controls]) {
        if (!reachable.some((model) => param in model.params)) {
          missing.push(
            `the ${node} panel draws '${param}' and no model it offers declares it, so that slot or control is mounted for nobody`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
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
