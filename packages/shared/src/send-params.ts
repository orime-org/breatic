// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A run laid out in our param names for provider to send (inner#1743).
 *
 * What a run means is the product's: a joining slot's files travel inside their pool and the prompt names them, a
 * list sends only its whole entries, nothing empty goes, a param another filled one replaces stays behind, and two
 * models carry settings in their prompt that no upstream has a field for. Which field each of our names becomes, and
 * how an upstream spells a value or a reference, is provider's.
 */

import { LIGHT_ANGLE_GRID, nearestCameraAngle } from "@shared/camera-angle.js";
import { completeEntries, isPresent } from "@shared/item-cap.js";
import { joinSlotFiles } from "@shared/join-slot-files.js";
import { LIGHT_INTENSITIES, LIGHT_QUALITIES, lightColorOf, lightDirectionPhrase } from "@shared/relight-terms.js";

/** What laying a run out reads off one declared param. */
export interface SendableParam {
  readonly default?: unknown;
  readonly fill?: string;
  readonly type?: string;
  readonly optional?: boolean;
  readonly joins?: string;
  readonly prompt_note?: string;
  readonly mention?: string;
  /** A param this one stands in for: only the one filled is sent. */
  readonly replaces?: string;
  /** An items list's fields, every one of which an entry fills to be sent. */
  readonly fields?: Readonly<Record<string, { values?: readonly unknown[] }>>;
}

/** What laying a run out reads off one catalog model. */
export interface SendableModel {
  readonly name: string;
  readonly takes_prompt?: boolean;
  readonly params?: Readonly<Record<string, SendableParam>>;
}

/** A run as provider takes it. */
export interface SendableRun {
  /** Our params, by our names. */
  params: Record<string, unknown>;
  prompt: string;
}

/** How one model writes settings no upstream has a field for: the params it reads itself, and what it makes of them. */
interface PromptBuilder {
  readonly consumes: ReadonlySet<string>;
  build(prompt: string, params: Readonly<Record<string, unknown>>): { prompt: string; params: Record<string, unknown> };
}

/** What the relight result keeps of the source. */
const PRESERVE = ["subject", "face", "pose", "clothing", "background", "composition"];

/** What the light reference lends for each setting left on Auto, by its key in the lighting block. */
const LENT = [
  ["intensity", "contrast"],
  ["color", "colour"],
  ["quality", "shadow quality"],
] as const;

/**
 * What the light reference lends, named by its place in the images, as Google's examples do: the direction always,
 * and each setting the lighting block leaves out because the user left it on Auto; a setting chosen by hand overrides
 * it (inner#1304 B3).
 * @param lighting - The lighting block, written without a direction.
 * @returns The sentence.
 */
function referenceOf(lighting: Readonly<Record<string, string>>): string {
  const taken = ["direction", ...LENT.filter(([key]) => lighting[key] === undefined).map(([, word]) => word)];
  const set = Object.keys(lighting).length > 0 ? " Where `lighting` gives a value, use it instead of the second image's." : "";
  return `Take the lighting of the second image: its ${new Intl.ListFormat("en").format(taken)}. Take nothing else from it.${set}`;
}

/**
 * The lighting block: each setting not left on Auto, the direction only when no reference decides it.
 * @param params - The run's params.
 * @param referenced - Whether a light reference is sent.
 * @returns The block, empty when every setting is decided elsewhere.
 */
function lightingOf(params: Readonly<Record<string, unknown>>, referenced: boolean): Record<string, string> {
  const lighting: Record<string, string> = {};
  if (!referenced) {
    // The server checks the range only; a value between steps reads as its nearest one.
    const at = nearestCameraAngle({ azimuth: Number(params.light_azimuth), elevation: Number(params.light_elevation), distance: 1 }, LIGHT_ANGLE_GRID);
    lighting.direction = lightDirectionPhrase(at.azimuth, at.elevation);
  }
  const color = lightColorOf(params.light_color, params.light_color_hex);
  if (color !== undefined) lighting.color = color.phrase;
  const intensity = LIGHT_INTENSITIES[String(params.light_intensity)];
  if (intensity !== undefined) lighting.intensity = intensity;
  const quality = LIGHT_QUALITIES[String(params.light_quality)];
  if (quality !== undefined) lighting.quality = quality;
  return lighting;
}

/**
 * The relight tool's model (inner#1304). Nano Banana 2's edit endpoint has no lighting fields, so the settings travel
 * as a JSON prompt; a light reference goes as the second image. With two images the endpoint takes the second one's
 * shape unless told a ratio, so the source's ratio, which the server wrote, goes with the reference; one image keeps
 * the source's shape by itself.
 */
const RELIGHT: PromptBuilder = {
  consumes: new Set(["light_azimuth", "light_elevation", "light_color", "light_color_hex", "light_intensity", "light_quality", "light_reference", "aspect_ratio"]),
  build(prompt, params) {
    const reference = typeof params.light_reference === "string" ? params.light_reference : undefined;
    const lighting = lightingOf(params, reference !== undefined);
    const note = prompt.trim();
    const json = {
      task: "relight",
      ...(Object.keys(lighting).length > 0 && { lighting }),
      ...(reference !== undefined && { reference: referenceOf(lighting) }),
      ...(note !== "" && { note }),
      preserve: PRESERVE,
    };
    const added: Record<string, unknown> = {};
    if (reference !== undefined) {
      added.images = [...(Array.isArray(params.images) ? params.images : []), reference];
      const ratio = params.aspect_ratio;
      if (typeof ratio === "string" && ratio !== "auto") added.aspect_ratio = ratio;
    }
    return { prompt: JSON.stringify(json), params: added };
  },
};

/**
 * Nano Banana 2's camera, lens, focal length and aperture, when the user turned the camera on; the endpoint has no
 * camera fields.
 * @param params - The run's params.
 * @returns Each control set, in that order.
 */
function cameraOf(params: Readonly<Record<string, unknown>>): { camera?: string; lens?: string; focal_length?: string; aperture?: string } {
  if (params.enable_camera !== true) return {};
  return {
    ...(typeof params.camera === "string" && params.camera !== "" && { camera: params.camera }),
    ...(typeof params.lens === "string" && params.lens !== "" && { lens: params.lens }),
    ...(typeof params.focal_length === "number" && params.focal_length !== 0 && { focal_length: `${params.focal_length}mm` }),
    ...(typeof params.aperture === "string" && params.aperture !== "" && { aperture: params.aperture }),
  };
}

/**
 * Nano Banana 2's camera as the words a rewrite of its prompt is told: the controls set, joined.
 * @param params - The run's params.
 * @returns The camera, or empty when it is off.
 */
export function cameraPrompt(params: Readonly<Record<string, unknown>>): string {
  return Object.values(cameraOf(params)).join(", ");
}

/**
 * Nano Banana 2's camera controls: the prompt becomes a structured JSON description whose `technical` block carries
 * them. The whole cluster is opt-in behind `enable_camera`. The worker may replace the prompt with an LLM's rewrite in
 * the same shape before it sends (`prompt-rewrite.ts`).
 */
const CAMERA: PromptBuilder = {
  consumes: new Set(["enable_camera", "camera", "lens", "focal_length", "aperture"]),
  build(prompt, params) {
    const technical = cameraOf(params);
    return { prompt: JSON.stringify(Object.keys(technical).length > 0 ? { subject: prompt, technical } : { subject: prompt }), params: {} };
  },
};

/** The models whose settings travel in their prompt, by name. */
const PROMPT_BUILDERS: ReadonlyMap<string, PromptBuilder> = new Map([
  ["nano-banana-2", CAMERA],
  ["nano-banana-2-relight", RELIGHT],
]);

/**
 * Lay a run out for provider to send: joining slots folded into their pools (the prompt naming their files by neutral
 * reference), items lists kept to their whole entries, empty values and undeclared params left out, a param another
 * filled one replaces left out, and a model's prompt-borne settings written into its prompt.
 * @param model - The model's catalog entry.
 * @param params - The run's params, validated and resolved.
 * @param prompt - The user's prompt, its references already neutral.
 * @returns The params and prompt to send.
 */
export function paramsToSend(model: SendableModel, params: Readonly<Record<string, unknown>>, prompt: string): SendableRun {
  const declared = model.params ?? {};
  const builder = PROMPT_BUILDERS.get(model.name);
  const joined = joinSlotFiles(declared, params, model.takes_prompt === false ? "" : prompt);
  const sent: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(declared)) {
    if (builder?.consumes.has(name) === true) continue;
    const value = spec.type === "items" ? completeEntries(joined.params[name], spec.fields ?? {}) : joined.params[name];
    if (isPresent(value)) sent[name] = value;
  }
  for (const name of Object.keys(sent)) {
    const replaced = declared[name]?.replaces;
    if (replaced !== undefined) delete sent[replaced];
  }
  if (builder === undefined) return { params: sent, prompt: joined.prompt };
  const built = builder.build(joined.prompt, params);
  return { params: { ...sent, ...built.params }, prompt: built.prompt };
}
