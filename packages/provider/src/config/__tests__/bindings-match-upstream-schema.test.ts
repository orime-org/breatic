// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaBinding } from "@provider/config/schema.js";
import { fieldFits, missingRequired, type Leaf, type SchemaSnapshot } from "@provider/config/upstream-schema.js";
import { adapterOf } from "@provider/media/adapters.js";
import { buildBody } from "@provider/media/body.js";
import type { StepContext } from "@provider/media/adapter.js";
import { rejectedInput, type EstimateInput } from "@provider/pricing/estimate.js";
import { createProvider } from "@provider/provider.js";
import { ROOT, catalog, shipped } from "./shipped.js";
import { RESELLER_LACKS, WAVESPEED_LACKS } from "./wavespeed-lacks.js";

/** One param of our catalog as its yaml writes it. */
interface CatalogParam {
  values?: (string | number | boolean)[];
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  type?: string;
  fields?: Record<string, { type?: string; values?: (string | number | boolean)[]; max_chars?: number }>;
  /** The longest text a text param takes. */
  max_chars?: number;
  /** For shots: the line each is written into the prompt as, when they are not sent as a list. */
  into_prompt?: string;
  remote_source?: string;
  /** The media kind of a single-file param. */
  accepts?: string;
}

const SNAPSHOTS = resolve(ROOT, "packages/provider/test/fixtures/upstream-schemas");
const SAMPLE_URL = "https://example.com/sample.png";
const SAMPLE_TEXT = "sample text";
/** A text sample that is also a single word, for item fields an upstream may restrict to word characters. */
const SAMPLE_WORD = "sample";

/**
 * The committed schema snapshot of one upstream endpoint.
 * @param upstream - The upstream's name.
 * @param endpoint - The model id or step endpoint on it.
 * @returns The snapshot, or undefined when none is committed.
 */
function snapshotFor(upstream: string, endpoint: string): SchemaSnapshot | undefined {
  const path = resolve(SNAPSHOTS, upstream, `${endpoint}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SchemaSnapshot) : undefined;
}

/**
 * The value at a dotted path of a body.
 * @param body - The body.
 * @param path - The path.
 * @returns The value, or undefined.
 */
function at(body: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, key) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined), body);
}

/**
 * Every value of a range from its low to its high end.
 * @param param - The range.
 * @returns The values.
 */
function everyStep(param: CatalogParam): number[] {
  const step = param.step ?? 1;
  const out: number[] = [];
  for (let v = param.min!; v <= param.max! + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/**
 * The sample values of one of our params that this binding sends: every offered value,
 * a range's ends and default (every step when the binding respells it or the upstream
 * types it differently), less those `supported` keeps out.
 * @param name - The param.
 * @param param - The catalog's param.
 * @param binding - The binding.
 * @param snapshot - The upstream's schema.
 * @returns The values.
 */
function samplesOf(name: string, param: CatalogParam, binding: MediaBinding, snapshot: SchemaSnapshot): unknown[] {
  const bound = binding.params?.[name];
  if (bound === undefined) return [];
  let values: unknown[];
  if (param.remote_source === "voices") values = Object.keys(binding.voice_map?.[name] ?? {}).length > 0 ? Object.keys(binding.voice_map![name]!) : (param.values ?? []);
  else if (param.values !== undefined) values = param.values;
  else if (param.min !== undefined && param.max !== undefined) {
    const numeric = (snapshot.fields[bound.field] ?? []).some((leaf) => leaf.type === "number" || leaf.type === "integer");
    values = bound.values !== undefined || bound.as !== undefined || !numeric ? everyStep(param) : [param.min, param.max, param.default ?? param.min];
  } else if (param.type === "items") values = [[sampleItem(param), sampleItem(param)]];
  else if (param.type === "list") values = [[SAMPLE_URL]];
  else if (param.accepts !== undefined) values = [SAMPLE_URL];
  else if (param.default !== undefined && param.default !== null) values = [param.default];
  else if (param.remote_source === undefined) values = [SAMPLE_TEXT];
  else values = [];
  return bound.supported === undefined ? values : values.filter((v) => bound.supported!.includes(v as string | number | boolean));
}

/**
 * One sample item of an `items` param from its fields.
 * @param param - The param.
 * @returns The item.
 */
function sampleItem(param: CatalogParam): Record<string, unknown> {
  return Object.fromEntries(Object.entries(param.fields ?? {}).map(([sub, f]) => [sub, f.values?.[0] ?? SAMPLE_WORD]));
}

/**
 * The value a run sends for a param when it does not choose one.
 * @param name - The param.
 * @param param - The catalog's param.
 * @param binding - The binding.
 * @param snapshot - The upstream's schema.
 * @returns The value, or undefined.
 */
function defaultOf(name: string, param: CatalogParam, binding: MediaBinding, snapshot: SchemaSnapshot): unknown {
  return param.default ?? samplesOf(name, param, binding, snapshot)[0] ?? (param.remote_source === undefined ? undefined : SAMPLE_TEXT);
}

/**
 * The context an extra step's body is built from, with sample values.
 * @param binding - The binding.
 * @param param - The param the step serves.
 * @returns The context.
 */
function sampleStep(binding: MediaBinding, param: string | undefined): StepContext {
  return {
    source: () => SAMPLE_URL,
    params: {},
    prompt: SAMPLE_TEXT,
    binding,
    customVoiceId: "voice-sample",
    voice: () => "voice-sample",
    description: SAMPLE_TEXT,
    itemIndex: 0,
    param,
  };
}

/**
 * The value an upstream uses for a field a request leaves out; null and none are the same.
 * @param leaves - The field's shapes.
 * @returns The value, or undefined when the schema states none.
 */
function defaultIn(leaves: readonly Leaf[] | undefined): unknown {
  return leaves?.find((leaf) => leaf.default !== undefined && leaf.default !== null)?.default;
}

/**
 * Every dotted path a body writes, its objects included.
 * @param body - The body.
 * @param at - The path of the body.
 * @returns The paths.
 */
function pathsOf(body: Record<string, unknown>, at = ""): string[] {
  return Object.entries(body).flatMap(([key, value]) => {
    const path = at === "" ? key : `${at}.${key}`;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? [path, ...pathsOf(value as Record<string, unknown>, path)] : [path];
  });
}

/** One endpoint a run reaches: its schema, the fields it writes and the objects it builds field by field, by dotted path. */
interface Reached {
  upstream: string;
  endpoint: string;
  snapshot: SchemaSnapshot;
  written: ReadonlySet<string>;
  built: ReadonlySet<string>;
}

/**
 * The fields a binding can ever write on its model's endpoint (its prompt field, every
 * param's field and every fixed field, with the objects they sit in), and the objects among
 * them it builds field by field (`voice_setting` of `voice_setting.voice_id`).
 * @param binding - The binding.
 * @returns The dotted paths.
 */
function everWritten(binding: MediaBinding): { written: Set<string>; built: Set<string> } {
  const fields = [binding.prompt_field, ...Object.values(binding.params ?? {}).map((p) => p.field), ...Object.keys(binding.fixed ?? {})].filter((f): f is string => f !== undefined);
  const prefixes = (f: string): string[] => f.split(".").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("."));
  return { written: new Set([...fields, ...fields.flatMap(prefixes)]), built: new Set(fields.flatMap(prefixes)) };
}

/**
 * The objects a body carries, by dotted path.
 * @param body - The body.
 * @param at - The path of the body.
 * @returns The paths.
 */
function objectsOf(body: Record<string, unknown>, at = ""): string[] {
  return Object.entries(body).flatMap(([key, value]) => {
    const path = at === "" ? key : `${at}.${key}`;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? [path, ...objectsOf(value as Record<string, unknown>, path)] : [];
  });
}

/**
 * The fields of a schema a request leaves to the upstream: at the top level, or inside an
 * object the request builds field by field. A field inside an object a param writes whole
 * is that param's to fill.
 * @param reached - The endpoint.
 * @returns The dotted paths.
 */
function leftOut(reached: Reached): string[] {
  return Object.keys(reached.snapshot.fields).filter((path) => {
    if (reached.written.has(path)) return false;
    const parent = path.slice(0, Math.max(0, path.lastIndexOf(".")));
    return parent === "" || reached.built.has(parent) || (!reached.written.has(parent) && implied(reached.snapshot, parent));
  });
}

/**
 * Whether the upstream builds an object a request leaves out: one that is neither required nor nullable and
 * states no default of its own, so its fields take their defaults.
 * @param snapshot - The schema.
 * @param path - The object's dotted path.
 * @returns True for such an object.
 */
function implied(snapshot: SchemaSnapshot, path: string): boolean {
  const leaves = snapshot.fields[path] ?? [];
  const parent = path.slice(0, Math.max(0, path.lastIndexOf(".")));
  return leaves.length > 0 && leaves.every((leaf) => leaf.type === "object" && leaf.default === undefined)
    && !(snapshot.required ?? []).includes(path) && (parent === "" || implied(snapshot, parent));
}

/**
 * The field of another endpoint that is this one: the same dotted path, else the one field
 * whose last segment matches (`voice_setting.emotion` on one is `emotion` on another).
 * @param path - The field here.
 * @param other - The other endpoint's schema.
 * @returns Its path there, if exactly one.
 */
function counterpart(path: string, other: SchemaSnapshot): string | undefined {
  if (other.fields[path] !== undefined) return path;
  const last = path.slice(path.lastIndexOf(".") + 1);
  const same = Object.keys(other.fields).filter((p) => p.slice(p.lastIndexOf(".") + 1) === last);
  return same.length === 1 ? same[0] : undefined;
}

/**
 * Fields a reseller leaves at a default other than WaveSpeed's, or than another reseller's
 * when WaveSpeed has no such field, which the same run then reads differently there.
 * Keyed `upstream endpoint field`; each says why the two defaults give the same result.
 */
const SAME_EFFECT: Readonly<Record<string, string>> = {
  ...Object.fromEntries(["fal-ai/minimax/speech-2.8-hd", "speak:fal-ai/minimax/speech-2.8-hd"].flatMap((endpoint) => ["bitrate", "channel", "format", "sample_rate"].map((field) => [
    `fal ${endpoint} audio_setting.${field}`,
    "fal's mp3, 32 kHz, mono, 128 kb/s is what WaveSpeed's MiniMax Speech 2.8 HD returns with none of these set (measured)",
  ]))),
  "fal krea/v2/large/text-to-image image_style_references": "an empty list of style references and none at all both apply no style reference",
  "fal alibaba/wan-3.0/image-to-video aspect_ratio": "fal's adaptive and WaveSpeed's none both follow the input image (WaveSpeed: 'If not specified, it is adapted to the input image')",
  "fal fal-ai/minimax/speech-2.8-hd voice_setting.voice_id": "WaveSpeed requires voice_id, so a run without a voice has no WaveSpeed result to match",
  "sandbase minimax/speech/2.8/hd voice_id": "WaveSpeed requires voice_id, so a run without a voice has no WaveSpeed result to match",
  "fal fal-ai/nano-banana-2/edit aspect_ratio": "fal's auto and WaveSpeed's none both take the input image's ratio (WaveSpeed: 'If not specified, it is determined automatically from the input image')",
};

const config = shipped();
const models = new Map(catalog().models.map((m) => [m.name, m.params as Record<string, CatalogParam>]));
const cases = Object.entries(config.media.models).flatMap(([model, { upstreams }]) => upstreams.map((binding) => ({ model, binding })));
const provider = createProvider({ config, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
/**
 * The longest text the model's vendor takes in one of our params (`prompt` for the prompt), from its limits.
 * @param model - Our model.
 * @param param - Our param name.
 * @returns The length, or undefined when the vendor states none.
 */
function vendorLength(model: string, param: string): number | undefined {
  const bounds = (config.media.models[model]?.rejects ?? []).flatMap(({ when }) => {
    const match = /^\$length\((\w+)\)\s*>\s*(\d+)$/.exec(when.trim());
    return match?.[1] === param ? [Number(match[2])] : [];
  });
  return bounds.length === 0 ? undefined : Math.min(...bounds);
}

/**
 * A binding's condition read in our param names: each upstream field it writes a param or the prompt to, renamed.
 * @param binding - The binding.
 * @param when - One of its conditions.
 * @returns The condition over our names, spaces dropped.
 */
function inOurNames(binding: MediaBinding, when: string): string {
  const ours = new Map([...Object.entries(binding.params ?? {}).map(([param, bound]) => [bound.field, param] as const), ...(binding.prompt_field === undefined ? [] : [[binding.prompt_field, "prompt"] as const])]);
  return when.replace(/\b[a-z_][a-z0-9_]*\b/g, (name) => ours.get(name) ?? name).replace(/\s+/g, "");
}

/** The longest prompt each catalog model takes, where it states one. */
const promptLimits = new Map(catalog().models.flatMap((m) => (m.max_input_chars === undefined ? [] : [[m.name, m.max_input_chars] as const])));

/**
 * The endpoints one binding's runs reach: the model's own, and each extra step's.
 * @param binding - The binding.
 * @returns Those with a committed snapshot.
 */
function reachedBy(binding: MediaBinding): Reached[] {
  const kind = config.upstreams[binding.upstream]?.kind;
  const own = snapshotFor(binding.upstream, binding.model_id);
  const out: Reached[] = own === undefined ? [] : [{ upstream: binding.upstream, endpoint: binding.model_id, snapshot: own, ...everWritten(binding) }];
  for (const step of binding.extra_steps ?? []) {
    const snapshot = snapshotFor(binding.upstream, step.endpoint);
    const codec = kind === undefined ? undefined : adapterOf(kind).steps[step.kind];
    if (snapshot === undefined || codec === undefined) continue;
    const body = codec.body(sampleStep(binding, step.for_param));
    out.push({ upstream: binding.upstream, endpoint: `${step.kind}:${step.endpoint}`, snapshot, written: new Set(pathsOf(body)), built: new Set(objectsOf(body)) });
  }
  return out;
}

/**
 * The same endpoint of another binding of the model: its own, or its step of the same kind.
 * @param reached - The endpoint here.
 * @param binding - The other binding.
 * @returns It, if that binding reaches one.
 */
function sameOn(reached: Reached, binding: MediaBinding): Reached | undefined {
  const all = reachedBy(binding);
  const step = reached.endpoint.includes(":") ? reached.endpoint.slice(0, reached.endpoint.indexOf(":") + 1) : undefined;
  return step === undefined ? all.find((r) => !r.endpoint.includes(":")) : all.find((r) => r.endpoint.startsWith(step));
}

/**
 * Whether a reject of a binding names a field: by its upstream name, or as the list it sits in.
 * @param binding - The binding.
 * @param test - What the condition must match.
 * @returns True when some reject does.
 */
function rejectMatches(binding: MediaBinding, test: RegExp): boolean {
  return (binding.rejects ?? []).some((r) => test.test(r.when));
}

/**
 * Escape a field name for a regular expression.
 * @param name - The name.
 * @returns The escaped name.
 */
const escaped = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One string field a run writes from text, with the longest text our catalog lets a run put there. */
interface TextField {
  /** Where it is, for the message. */
  where: string;
  /** The name a reject's condition reads it by: the upstream field, the prompt field, or the list it sits in. */
  named: string;
  /** Whether it is a sub-field of each item of the list `named`. */
  inList: boolean;
  leaves: Leaf[];
  ours?: number;
  /** Our param it carries (`prompt` for the prompt), whose vendor limit applies to it; absent for a list's sub-field. */
  param?: string;
}

/**
 * The body of a binding's own call: its clone codec's when the call clones a source, else the binding's body.
 * @param binding - The binding.
 * @param prompt - The run's prompt.
 * @returns The body.
 */
function ownBody(binding: MediaBinding, prompt: string): Record<string, unknown> {
  const kind = config.upstreams[binding.upstream]?.kind;
  const codec = binding.reused_by === undefined || kind === undefined ? undefined : adapterOf(kind).steps.voice;
  return codec === undefined ? buildBody(binding, { prompt, params: {} }) : codec.body({ ...sampleStep(binding, undefined), prompt });
}

/**
 * The string fields a binding's runs write from text: the prompt wherever a call carries it,
 * text params, and text sub-fields of list items.
 * @param model - The model.
 * @param binding - The binding.
 * @param snapshot - The upstream's schema of the model's own endpoint.
 * @returns Each field.
 */
function textFields(model: string, binding: MediaBinding, snapshot: SchemaSnapshot): TextField[] {
  const out: TextField[] = [];
  const prompt = binding.prompt_field;
  if (prompt !== undefined) {
    if (ownBody(binding, SAMPLE_TEXT)[prompt] === SAMPLE_TEXT) out.push({ where: prompt, named: prompt, inList: false, leaves: snapshot.fields[prompt] ?? [], ours: promptLimits.get(model), param: "prompt" });
    const kind = config.upstreams[binding.upstream]?.kind;
    for (const step of binding.extra_steps ?? []) {
      const codec = kind === undefined ? undefined : adapterOf(kind).steps[step.kind];
      const stepSnapshot = snapshotFor(binding.upstream, step.endpoint);
      if (codec === undefined || stepSnapshot === undefined) continue;
      const body = codec.body({ ...sampleStep(binding, step.for_param), description: SAMPLE_WORD });
      for (const path of pathsOf(body).filter((p) => at(body, p) === SAMPLE_TEXT)) {
        out.push({ where: `${step.kind}:${step.endpoint} ${path}`, named: prompt, inList: false, leaves: stepSnapshot.fields[path] ?? [], ours: promptLimits.get(model), param: "prompt" });
      }
    }
  }
  for (const [name, param] of Object.entries(models.get(model) ?? {})) {
    const bound = binding.params?.[name];
    if (bound === undefined) continue;
    if (param.type === "text") out.push({ where: bound.field, named: bound.field, inList: false, leaves: snapshot.fields[bound.field] ?? [], ours: param.max_chars, param: name });
    if (param.type !== "items") continue;
    const items = (snapshot.fields[bound.field] ?? []).find((leaf) => leaf.type === "array")?.items;
    for (const [sub, spec] of Object.entries(param.fields ?? {})) {
      const subField = bound.item_fields?.[sub]?.field;
      if (spec.type !== "text" || subField === undefined || items === undefined) continue;
      out.push({ where: `${bound.field}[].${subField}`, named: bound.field, inList: true, leaves: items.fields[subField] ?? [], ours: spec.max_chars });
    }
  }
  return out;
}

/**
 * A sample run of these params and prompt, with no clip lengths known.
 * @param params - Our params.
 * @param prompt - The prompt.
 * @returns The run.
 */
function sampleRun(params: Record<string, unknown>, prompt: string): EstimateInput {
  return { params, prompt, durations: {}, placeholders: [], durationsMissing: [] };
}

/**
 * A run this binding takes, as the application sends one: every param at its catalog default (null left unset),
 * and a param whose default the binding refuses at the first of its sample values the binding takes.
 * @param model - The model.
 * @param binding - The binding.
 * @param snapshot - The upstream's schema.
 * @returns The params.
 */
async function takenRun(model: string, binding: MediaBinding, snapshot: SchemaSnapshot): Promise<Record<string, unknown>> {
  const rules = provider.pricingRules(model);
  const params = Object.entries(models.get(model) ?? {});
  // A param whose catalog default is null is sent unset, as the application sends it.
  let taken: Record<string, unknown> = Object.fromEntries(params.map(([name, param]) => [name, param.default]).filter(([, v]) => v !== undefined));
  for (const [name, param] of params) {
    for (const value of [taken[name], ...samplesOf(name, param, binding, snapshot)]) {
      const trial = { ...taken, [name]: value };
      if ((await rejectedInput(rules, binding.upstream, sampleRun(trial, SAMPLE_TEXT))) === undefined) {
        taken = trial;
        break;
      }
    }
  }
  return taken;
}

/** Content-screening fields: they decide only whether an upstream refuses a run, and each upstream refuses by its own policy. */
const SCREENING: ReadonlySet<string> = new Set(["enable_safety_checker", "safety_tolerance"]);

/**
 * The fal endpoint behind each SandBase model SandBase's model list answered as `owned_by: fal.ai` on 2026-11-01 (the
 * list now names the vendors): SandBase passes a run on to it, so every field of it SandBase does not take runs at fal's default.
 */
const SANDBASE_ON_FAL: Readonly<Record<string, string>> = {
  "alibaba/qwen-image-edit/2511/multiple-angles": "fal-ai/qwen-image-edit-2511-multiple-angles",
  "bytedance/dreamactor/2.0": "fal-ai/bytedance/dreamactor/v2",
  "bytedance/omnihuman/1.5": "fal-ai/bytedance/omnihuman/v1.5",
  "elevenlabs/v3": "fal-ai/elevenlabs/tts/eleven-v3",
  "google/gemini-3.1-flash-tts": "fal-ai/gemini-3.1-flash-tts",
  "ideogram-ai/ideogram-v3": "fal-ai/ideogram/v3",
  "meigen/infinitetalk/video-to-video": "fal-ai/infinitalk/video-to-video",
  "sync/lipsync/3.0/video-to-video": "fal-ai/sync-lipsync/v3",
  "tencent/hunyuan-3d/3.0/image-to-3d": "fal-ai/hunyuan3d-v3/image-to-3d",
};

/** A field a binding leaves at its upstream's default that needs a reviewed entry, and why it was found. */
interface Unreviewed {
  key: string;
  shown: string;
}

/**
 * The fields a reseller binding leaves at a default whose result no counterpart decides: fields WaveSpeed's same
 * endpoint does not have, every left-out field when the model has no WaveSpeed binding, and the fields of the fal
 * endpoint behind a SandBase model that SandBase does not take. Screening fields are decided for every endpoint.
 * @param model - The model.
 * @param binding - A reseller binding.
 * @returns Each such field, keyed `upstream endpoint field`.
 */
function needingReview(model: string, binding: MediaBinding): Unreviewed[] {
  const wavespeed = (config.media.models[model]?.upstreams ?? []).find((b) => b.upstream === "wavespeed");
  const out: Unreviewed[] = [];
  /**
   * Record a field left at its default unless it is a screening field.
   * @param upstream - Whose endpoint.
   * @param endpoint - The endpoint, `kind:` before a step's.
   * @param path - The field.
   * @param leaves - Its shapes.
   */
  const add = (upstream: string, endpoint: string, path: string, leaves: readonly Leaf[] | undefined): void => {
    if (SCREENING.has(path.slice(path.lastIndexOf(".") + 1))) return;
    out.push({ key: `${upstream} ${endpoint} ${path}`, shown: `${upstream} ${endpoint} ${path}=${JSON.stringify(defaultIn(leaves))}` });
  };
  for (const here of reachedBy(binding)) {
    const official = wavespeed === undefined ? undefined : sameOn(here, wavespeed);
    for (const path of leftOut(here)) {
      if (defaultIn(here.snapshot.fields[path]) === undefined) continue;
      if (official !== undefined && counterpart(path, official.snapshot) !== undefined) continue;
      if (wavespeed !== undefined && official === undefined) continue;
      add(here.upstream, here.endpoint, path, here.snapshot.fields[path]);
    }
  }
  const behind = binding.upstream === "sandbase" ? SANDBASE_ON_FAL[binding.model_id] : undefined;
  const own = snapshotFor(binding.upstream, binding.model_id);
  const fal = behind === undefined ? undefined : snapshotFor("fal", behind);
  if (fal !== undefined && own !== undefined) {
    const officialSnapshot = wavespeed === undefined ? undefined : snapshotFor("wavespeed", wavespeed.model_id);
    const sent = everWritten(binding).written;
    for (const [path, leaves] of Object.entries(fal.fields)) {
      if (path === "" || path.includes(".") || defaultIn(leaves) === undefined || sent.has(path)) continue;
      // A field SandBase takes with a default of its own runs at that default; one it takes with none runs at fal's.
      if (own.fields[path] !== undefined && defaultIn(own.fields[path]) !== undefined) continue;
      const theirs = officialSnapshot === undefined ? undefined : counterpart(path, officialSnapshot);
      if (theirs !== undefined && JSON.stringify(defaultIn(officialSnapshot!.fields[theirs])) === JSON.stringify(defaultIn(leaves))) continue;
      add("fal", behind!, path, leaves);
    }
  }
  return out;
}

/**
 * The fields a reseller binding leaves out whose default differs from WaveSpeed's same field, or from another
 * reseller's where WaveSpeed has none; the SAME_EFFECT rows the review reads are keyed by them.
 * @param model - The model.
 * @param binding - A reseller binding.
 * @returns Each differing field, keyed `upstream endpoint field`.
 */
function leftOutDiffering(model: string, binding: MediaBinding): Unreviewed[] {
  const others = (config.media.models[model]?.upstreams ?? []).filter((b) => b !== binding);
  const wavespeed = others.find((b) => b.upstream === "wavespeed");
  const out: Unreviewed[] = [];
  for (const here of reachedBy(binding)) {
    const official = wavespeed === undefined ? undefined : sameOn(here, wavespeed);
    const resellers = others.filter((b) => b.upstream !== "wavespeed").map((b) => sameOn(here, b)).filter((r): r is Reached => r !== undefined);
    for (const path of leftOut(here)) {
      const mine = defaultIn(here.snapshot.fields[path]);
      const atOfficial = official === undefined ? undefined : counterpart(path, official.snapshot);
      const compared = atOfficial !== undefined && official !== undefined
        ? [{ there: official, path: atOfficial }]
        : resellers.flatMap((r) => {
          const at = counterpart(path, r.snapshot);
          return at === undefined ? [] : [{ there: r, path: at }];
        });
      for (const { there, path: theirs } of compared) {
        // A field the other binding writes, or sits inside an object it writes whole, is not left to its default there.
        if (there.written.has(theirs) || [...there.written].some((w) => theirs.startsWith(`${w}.`) && !there.built.has(w))) continue;
        const other = defaultIn(there.snapshot.fields[theirs]);
        if (JSON.stringify(mine) !== JSON.stringify(other)) {
          out.push({ key: `${here.upstream} ${here.endpoint} ${path}`, shown: `${here.endpoint} ${path}=${JSON.stringify(mine)}, ${there.upstream} ${there.endpoint} ${theirs}=${JSON.stringify(other)}` });
        }
      }
    }
  }
  return out;
}

/**
 * The params a reseller binding sends nothing for when a run leaves them unset (null, cleared, or at the catalog
 * default the binding treats as absent), where the reseller's default differs from WaveSpeed's; the SAME_EFFECT rows
 * the review reads are keyed by them.
 * @param model - The model.
 * @param binding - A reseller binding.
 * @returns Each differing field, keyed `upstream model_id field`.
 */
function unsetDiffering(model: string, binding: MediaBinding): Unreviewed[] {
  const wavespeed = (config.media.models[model]?.upstreams ?? []).find((b) => b.upstream === "wavespeed");
  const snapshot = snapshotFor(binding.upstream, binding.model_id);
  if (wavespeed === undefined || snapshot === undefined) return [];
  const officialSnapshot = snapshotFor("wavespeed", wavespeed.model_id);
  const out: Unreviewed[] = [];
  for (const [name, param] of Object.entries(models.get(model) ?? {})) {
    const bound = binding.params?.[name];
    if (bound === undefined || bound.unset !== undefined) continue;
    // A run carries a param with offered values or a range at a value; one the reader can clear (text, a list) or
    // one whose default is null can arrive empty, one whose default is its absent value sends nothing, and the field
    // is then unsent unless the binding says what to send.
    const clearable = param.remote_source === undefined && (param.type === "text" || param.type === "list" || param.type === "items" || param.accepts !== undefined);
    const empties = [
      ...(param.default === null || param.default === undefined ? [null] : []),
      ...(param.default !== null && param.default !== undefined && param.default === bound.absent_value ? [param.default] : []),
      ...(clearable ? ["", []] : []),
    ];
    if (!empties.some((v) => at(buildBody(binding, { prompt: "", params: { [name]: v } }), bound.field) === undefined)) continue;
    const mine = defaultIn(snapshot.fields[bound.field]);
    if (mine === undefined) continue;
    const theirField = wavespeed.params?.[name]?.field;
    const theirs = theirField === undefined || officialSnapshot === undefined ? undefined : defaultIn(officialSnapshot.fields[theirField]);
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
      out.push({ key: `${binding.upstream} ${binding.model_id} ${bound.field}`, shown: `${name} -> ${bound.field}=${JSON.stringify(mine)}, WaveSpeed ${theirField ?? "(not sent)"}=${JSON.stringify(theirs)}` });
    }
  }
  return out;
}

/**
 * The fields WaveSpeed's endpoint leaves at a default that the reseller's same endpoint has no counterpart for;
 * the RESELLER_LACKS rows the review reads are keyed by them.
 * @param model - The model.
 * @param binding - A reseller binding.
 * @returns Each such field, keyed `endpoint field on upstream endpoint`.
 */
function resellerLacked(model: string, binding: MediaBinding): Unreviewed[] {
  const wavespeed = (config.media.models[model]?.upstreams ?? []).find((b) => b.upstream === "wavespeed");
  if (binding.upstream === "wavespeed" || wavespeed === undefined) return [];
  const out: Unreviewed[] = [];
  for (const official of reachedBy(wavespeed)) {
    const here = sameOn(official, binding);
    if (here === undefined) continue;
    for (const path of leftOut(official)) {
      if (defaultIn(official.snapshot.fields[path]) === undefined || counterpart(path, here.snapshot) !== undefined) continue;
      if (SCREENING.has(path.slice(path.lastIndexOf(".") + 1))) continue;
      const key = `${official.endpoint} ${path} on ${binding.upstream} ${here.endpoint}`;
      out.push({ key, shown: `${key}=${JSON.stringify(defaultIn(official.snapshot.fields[path]))}` });
    }
  }
  return out;
}

describe("the committed schema snapshots", () => {
  it("are only of endpoints some binding reaches, or the fal endpoint behind a bound SandBase model", () => {
    const reached = new Set(cases.flatMap(({ binding }) => [binding.model_id, ...(binding.extra_steps ?? []).map((s) => s.endpoint)].map((id) => `${binding.upstream}/${id}.json`)));
    for (const { binding } of cases) {
      const behind = binding.upstream === "sandbase" ? SANDBASE_ON_FAL[binding.model_id] : undefined;
      if (behind !== undefined) reached.add(`fal/${behind}.json`);
    }
    const files = (readdirSync(SNAPSHOTS, { recursive: true }) as string[]).filter((f) => f.endsWith(".json"));
    expect(files.filter((f) => !reached.has(f))).toEqual([]);
    const prices = resolve(ROOT, "packages/provider/test/fixtures/upstream-prices");
    const facts = (readdirSync(prices, { recursive: true }) as string[]).filter((f) => f.endsWith(".json"));
    expect(facts.filter((f) => !reached.has(f))).toEqual([]);
  });
});

describe("the stored price facts the formulas were written from", () => {
  it("hold the billing unit of every fal endpoint a binding prices", () => {
    const priced = cases.filter(({ binding }) => binding.upstream === "fal").flatMap(({ binding }) => [binding.model_id, ...(binding.extra_steps ?? []).filter((s) => s.pricing !== undefined).map((s) => s.endpoint)]);
    const missing = priced.filter((endpoint) => {
      const file = resolve(ROOT, "packages/provider/test/fixtures/upstream-prices/fal", `${endpoint}.json`);
      return !existsSync(file) || typeof (JSON.parse(readFileSync(file, "utf8")) as { unit?: unknown }).unit !== "string";
    });
    expect(missing).toEqual([]);
  });
});

describe("the reviewed fields WaveSpeed does not have", () => {
  it("names only fields some binding leaves at its default", () => {
    const left = new Set(cases.filter(({ binding }) => binding.upstream !== "wavespeed").flatMap(({ model, binding }) => needingReview(model, binding).map((u) => u.key)));
    expect(Object.keys(WAVESPEED_LACKS).filter((key) => !left.has(key))).toEqual([]);
  });

  it("names no screening field, which every endpoint leaves alike", () => {
    expect(Object.keys(WAVESPEED_LACKS).filter((key) => SCREENING.has(key.slice(key.lastIndexOf(" ") + 1).split(".").pop()!))).toEqual([]);
  });

  it("has the schema of the fal endpoint behind every bound SandBase model it maps", () => {
    const bound = new Set(cases.filter(({ binding }) => binding.upstream === "sandbase").map(({ binding }) => binding.model_id));
    expect(Object.entries(SANDBASE_ON_FAL).filter(([id, falId]) => bound.has(id) && snapshotFor("fal", falId) === undefined).map(([id]) => id)).toEqual([]);
  });

  it("keeps no RESELLER_LACKS row the review does not read", () => {
    const read = new Set(cases.flatMap(({ model, binding }) => resellerLacked(model, binding).map((u) => u.key)));
    expect(Object.keys(RESELLER_LACKS).filter((key) => !read.has(key))).toEqual([]);
  });

  it("keeps no SAME_EFFECT row the reviews do not read", () => {
    const resellers = cases.filter(({ binding }) => binding.upstream !== "wavespeed");
    const read = new Set(resellers.flatMap(({ model, binding }) => [...leftOutDiffering(model, binding), ...unsetDiffering(model, binding)].map((u) => u.key)));
    expect(Object.keys(SAME_EFFECT).filter((key) => !read.has(key))).toEqual([]);
  });
});

describe.each(cases)("$model on $binding.upstream", ({ model, binding }) => {
  const kind = config.upstreams[binding.upstream]?.kind;
  const snapshot = snapshotFor(binding.upstream, binding.model_id);
  const params = models.get(model) ?? {};

  it("has a committed schema snapshot", () => {
    expect(snapshot, `test/fixtures/upstream-schemas/${binding.upstream}/${binding.model_id}.json`).toBeDefined();
  });
  if (snapshot === undefined) return;

  it("writes its prompt and fixed fields into fields the upstream takes", () => {
    if (binding.prompt_field !== undefined) expect(fieldFits(snapshot, binding.prompt_field, SAMPLE_TEXT), binding.prompt_field).toBe(true);
    for (const [field, value] of Object.entries(binding.fixed ?? {})) {
      if (kind === "sandbase" && field === "mode") expect(snapshot.modes ?? [], "mode").toContain(value);
      else expect(fieldFits(snapshot, field, value), `${field}=${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("reads its outputs from a field the upstream answers", () => {
    if (binding.output_field === undefined) return;
    expect(Object.keys(snapshot.outputs ?? {}), binding.output_field).toContain(binding.output_field);
  });

  it("takes a run as the application sends one, so every class check below has a run to check", async () => {
    const base = await takenRun(model, binding, snapshot);
    expect(await rejectedInput(provider.pricingRules(model), binding.upstream, sampleRun(base, SAMPLE_TEXT)), JSON.stringify(base)).toBeUndefined();
  });

  it("writes every param, and every field of its list items, into a field the upstream has", () => {
    const unknown: string[] = [];
    for (const [name, bound] of Object.entries(binding.params ?? {})) {
      const leaves = snapshot.fields[bound.field];
      if (leaves === undefined) {
        unknown.push(`${name} -> ${bound.field}`);
        continue;
      }
      const items = leaves.find((leaf) => leaf.type === "array")?.items;
      for (const [sub, item] of Object.entries(bound.item_fields ?? {})) {
        if (items?.fields[item.field] === undefined) unknown.push(`${name}[].${sub} -> ${bound.field}[].${item.field}`);
      }
    }
    expect(unknown, unknown.join("\n")).toEqual([]);
  });

  it("writes every value of every param it sends as the upstream takes it, except a value its rejects keep out", async () => {
    const rules = provider.pricingRules(model);
    // Each value is checked on a run that otherwise passes the binding's rejects, so a reject keeps out only the value under test.
    const base = await takenRun(model, binding, snapshot);
    const bad: string[] = [];
    for (const [name, param] of Object.entries(params)) {
      const field = binding.params?.[name]?.field;
      // A param an extra step serves is sent as what that step made, not as the run's value.
      if (field === undefined || binding.extra_steps?.some((step) => step.for_param === name)) continue;
      for (const value of samplesOf(name, param, binding, snapshot)) {
        if ((await rejectedInput(rules, binding.upstream, sampleRun({ ...base, [name]: value }, SAMPLE_TEXT))) !== undefined) continue;
        const written = at(buildBody(binding, { prompt: "", params: { [name]: value } }), field);
        if (written === undefined) continue;
        if (!fieldFits(snapshot, field, written)) bad.push(`${name}=${JSON.stringify(value)} -> ${field}=${JSON.stringify(written)}`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("evaluates every reject and price it carries on every sample run without an error", async () => {
    const rules = provider.pricingRules(model);
    const base = await takenRun(model, binding, snapshot);
    const failures: string[] = [];
    const runs: Record<string, unknown>[] = [base, ...Object.entries(params).flatMap(([name, param]) => samplesOf(name, param, binding, snapshot).map((value) => ({ ...base, [name]: value })))];
    for (const values of runs) {
      for (const prompt of ["", SAMPLE_TEXT]) {
        const refused = await rejectedInput(rules, binding.upstream, sampleRun(values, prompt));
        if (refused !== undefined && "evaluationError" in refused) failures.push(`${JSON.stringify(values)} prompt=${JSON.stringify(prompt)}: ${refused.reason}: ${refused.evaluationError}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("sends every field the upstream requires", () => {
    const sample = Object.fromEntries(Object.entries(params).map(([name, param]) => [name, defaultOf(name, param, binding, snapshot)]));
    expect(missingRequired(snapshot, buildBody(binding, { prompt: SAMPLE_TEXT, params: sample }))).toEqual([]);
  });

  it("sends every field the upstream requires in a storyboard run, which carries shots and no prompt, or keeps the run out", async () => {
    // Shots written into the prompt (`into_prompt`) still send one; shots sent as a list replace it.
    const shots = Object.entries(params).filter(([, param]) => param.type === "items" && param.fields?.prompt !== undefined && param.into_prompt === undefined);
    if (shots.length === 0) return;
    const sample = Object.fromEntries(Object.entries(params).map(([name, param]) => [name, defaultOf(name, param, binding, snapshot)]));
    for (const [name, param] of shots) sample[name] = [sampleItem(param), sampleItem(param)];
    const missing = missingRequired(snapshot, buildBody(binding, { prompt: "", params: sample }));
    if (missing.length === 0) return;
    const run = { params: sample, prompt: "", durations: {}, placeholders: [], durationsMissing: [] };
    expect(await rejectedInput(provider.pricingRules(model), binding.upstream, run), missing.join(", ")).toBeDefined();
  });

  it("states as a reject each length bound and pattern of a text field it writes that our catalog and the model's vendor let a run break", () => {
    const unstated: string[] = [];
    for (const { where, named, inList, leaves, ours, param } of textFields(model, binding, snapshot)) {
      const text = leaves.find((leaf) => leaf.type === "string");
      if (text === undefined) continue;
      const length = inList ? `\\b${escaped(named)}\\b.*\\$length\\(` : `\\$length\\(\\s*${escaped(named)}\\s*\\)`;
      const max = text.maxLength;
      const allowed = Math.min(ours ?? Infinity, param === undefined ? Infinity : vendorLength(model, param) ?? Infinity);
      if (max !== undefined && allowed > max && !rejectMatches(binding, new RegExp(`${length}[^<>]*>\\s*${max}\\b`))) unstated.push(`${where} maxLength ${max}`);
      if (text.minLength !== undefined && text.minLength > 1 && !rejectMatches(binding, new RegExp(`${length}[^<>]*<\\s*${text.minLength}\\b`))) unstated.push(`${where} minLength ${text.minLength}`);
      if (text.pattern !== undefined && !rejectMatches(binding, new RegExp(`\\b${escaped(named)}\\b`))) unstated.push(`${where} pattern ${text.pattern}`);
    }
    expect(unstated, unstated.join("\n")).toEqual([]);
  });

  it("states each length reject of a field at the bound its upstream's schema gives, only where the model's vendor takes longer text", () => {
    const stale: string[] = [];
    for (const { when } of binding.rejects ?? []) {
      const match = /^\$length\((\w+)\)\s*>\s*(\d+)$/.exec(when.trim());
      if (match === null) continue;
      const bound = (snapshot.fields[match[1]!] ?? []).find((leaf) => leaf.type === "string")?.maxLength;
      if (bound !== undefined && bound !== Number(match[2])) stale.push(`${when}: the bound is ${bound}`);
      const vendor = vendorLength(model, inOurNames(binding, match[1]!));
      if (vendor !== undefined && vendor <= Number(match[2])) stale.push(`${when}: the model's vendor already refuses past ${vendor}`);
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("repeats no limit of the model's vendor", () => {
    const vendor = new Set((config.media.models[model]?.rejects ?? []).map((r) => r.when.replace(/\s+/g, "")));
    const repeated = (binding.rejects ?? []).filter((r) => vendor.has(inOurNames(binding, r.when))).map((r) => r.when);
    expect(repeated, repeated.join("\n")).toEqual([]);
  });

  it("leaves no field it does not send at a default other than WaveSpeed's, or than another reseller's where WaveSpeed has none", () => {
    if (binding.upstream === "wavespeed") return;
    const differ = leftOutDiffering(model, binding).filter((u) => SAME_EFFECT[u.key] === undefined).map((u) => u.shown);
    expect(differ, differ.join("\n")).toEqual([]);
  });

  it("leaves a field WaveSpeed does not have at its default only where that gives WaveSpeed's result", () => {
    if (binding.upstream === "wavespeed") return;
    const unreviewed = needingReview(model, binding).filter((u) => WAVESPEED_LACKS[u.key] === undefined).map((u) => u.shown);
    expect(unreviewed, unreviewed.join("\n")).toEqual([]);
  });

  it("lacks a field WaveSpeed leaves at its default only where that changes nothing WaveSpeed gives", () => {
    const unreviewed = resellerLacked(model, binding).filter((u) => RESELLER_LACKS[u.key] === undefined).map((u) => u.shown);
    expect(unreviewed, unreviewed.join("\n")).toEqual([]);
  });

  it("leaves a param the run does not set at a default that gives WaveSpeed's result", () => {
    if (binding.upstream === "wavespeed") return;
    const differ = unsetDiffering(model, binding).filter((u) => SAME_EFFECT[u.key] === undefined).map((u) => u.shown);
    expect(differ, differ.join("\n")).toEqual([]);
  });

  it("writes its extra steps into fields their endpoints take", () => {
    for (const step of binding.extra_steps ?? []) {
      const stepSnapshot = snapshotFor(binding.upstream, step.endpoint);
      expect(stepSnapshot, `${binding.upstream}/${step.endpoint}.json`).toBeDefined();
      const codec = kind === undefined ? undefined : adapterOf(kind).steps[step.kind];
      if (stepSnapshot === undefined || codec === undefined) continue;
      const body = codec.body(sampleStep(binding, step.for_param));
      for (const [field, value] of Object.entries(body)) expect(fieldFits(stepSnapshot, field, value), `${step.kind} ${field}`).toBe(true);
      expect(missingRequired(stepSnapshot, body), step.kind).toEqual([]);
    }
  });
});
