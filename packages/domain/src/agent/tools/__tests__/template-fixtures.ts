// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Fixture generation templates for the domain tests of the template framework
 * (inner#1345), their locale strings, and the proposal the agent would send
 * for one template.
 *
 * The fixtures stand outside the registry: a test hands them to `verdictFor`,
 * `answerFor` and the tool through their registry parameter. Their words are
 * not in `locales/*.json`, so `loadFixtureLocales` loads the real catalogs and
 * lays these strings over them; `loadLocales` alone puts the real ones back.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadLocales, MONOREPO_ROOT } from "@breatic/core";
import {
  markedSegments,
  setLocaleMessages,
  t,
  templateSkeleton,
  type GenerationTemplate,
  type PromptSegment,
} from "@breatic/shared";

import type { verdictFor } from "../propose-canvas-action.js";

/** What the model sends, as the tool's input. */
export type Sent = Parameters<typeof verdictFor>[0];

/** One node as the model sends it. */
export type SentNode = Sent["nodes"][number];

/** The image edit model every image fixture node runs. */
export const EDIT = "nano-banana-pro-edit-ultra";
/** A text-to-image model. */
export const T2I = "nano-banana-2";
/** A multi-shot model whose pool takes pictures. */
export const SHOT_MODEL = "happyhorse-1.1-reference-to-video";

/**
 * The multi-node fixture of design 6.9: an upstream generate node (`sketch`)
 * feeding the anchor (`sheet`) through a template edge into a slot param; one
 * input feeding only the upstream node (`pose`); two inputs of one type
 * feeding the anchor (`front`, `back`); one input feeding both (`character`);
 * a resource wired only into the upstream node (`palette`); two steps.
 */
export const SHEET: GenerationTemplate = {
  id: "fixture-sheet",
  anchor: "sheet",
  nodes: [
    { key: "sheet", role: "generate", type: "image", mode: "i2i", model: EDIT, params: { aspect_ratio: "16:9", resolution: "4k" } },
    { key: "sketch", role: "generate", type: "image", mode: "i2i", model: EDIT, params: { aspect_ratio: "1:1" } },
    { key: "palette", role: "source", type: "image", resource: "templates/fixture-sheet/palette.png" },
  ],
  edges: [
    { from: "palette", to: "sketch", into: "pool" },
    { from: "sketch", to: "sheet", into: "style_images" },
  ],
  inputs: [
    { key: "pose", type: "image", feeds: ["sketch"] },
    { key: "front", type: "image" },
    { key: "back", type: "image" },
    { key: "character", type: "image", feeds: ["sketch", "sheet"] },
  ],
  steps: ["split", "pick"],
  agentNote: "a fixture character sheet drawn over a generated sketch",
};

/** A one-node fixture with one input and no steps, the shape the two migrated templates take. */
export const SOLO: GenerationTemplate = {
  id: "fixture-solo",
  anchor: "edit",
  nodes: [{ key: "edit", role: "generate", type: "image", mode: "i2i", model: EDIT, params: { aspect_ratio: "1:1" } }],
  edges: [],
  inputs: [{ key: "reference", type: "image" }],
  steps: [],
  agentNote: "a fixture watercolour of one picture",
};

/** A one-node fixture with no input and one step. */
export const STEPPED: GenerationTemplate = {
  id: "fixture-steps",
  anchor: "draw",
  nodes: [{ key: "draw", role: "generate", type: "image", mode: "t2i", model: T2I, params: {} }],
  edges: [],
  inputs: [],
  steps: ["upscale"],
  agentNote: "a fixture picture to upscale afterwards",
};

/** A fixture whose anchor runs in the multi_shot mode, with a generated still in its pool. */
export const SHOTS: GenerationTemplate = {
  id: "fixture-shots",
  anchor: "clip",
  nodes: [
    { key: "clip", role: "generate", type: "video", mode: "multi_shot", model: SHOT_MODEL, params: {} },
    { key: "still", role: "generate", type: "image", mode: "t2i", model: T2I, params: {} },
  ],
  edges: [{ from: "still", to: "clip", into: "pool" }],
  inputs: [],
  steps: [],
  agentNote: "a fixture clip of a generated still",
};

/** Every fixture, as a registry. */
export const FIXTURES: readonly GenerationTemplate[] = [SHEET, SOLO, STEPPED, SHOTS];

/** The fixtures' strings, under `canvas.template`, by locale. */
const STRINGS: Record<string, Record<string, unknown>> = {
  en: {
    "fixture-sheet": {
      name: "Fixture sheet",
      prompt: "(💡 Generate Sketch first, then pick it into the style slot)Draw [📎 Front view] and [📎 Back view] of [📎 Character] side by side on one sheet.",
      node: {
        sketch: { name: "Sketch", prompt: "A rough sketch of [📎 Character] in the pose of [📎 Pose], in the colours of [📎 Palette]." },
        palette: { name: "Palette" },
      },
      input: {
        pose: { name: "Pose", note: "Put a pose picture in Pose first" },
        front: { name: "Front view", note: "Put the front view in Front view first" },
        back: { name: "Back view", note: "Put the back view in Back view first" },
        character: { name: "Character", note: "Put the character in Character first" },
      },
      step: {
        split: "Once Fixture sheet has generated, right-click it and pick Tools, then Grid split",
        pick: "Drag the panel you like into a new node",
      },
    },
    "fixture-solo": {
      name: "Fixture solo",
      prompt: "Redraw [📎 Reference] as a watercolour.",
      input: { reference: { name: "Reference", note: "Put the reference in Reference first" } },
    },
    "fixture-steps": {
      name: "Fixture steps",
      prompt: "A lighthouse at dawn.",
      step: { upscale: "Once it has generated, upscale it from Tools" },
    },
    "fixture-shots": {
      name: "Fixture shots",
      prompt: "(💡 Generate Still first)[📎 Still] walks along the shore.",
      node: { still: { name: "Still", prompt: "A woman in a yellow coat." } },
    },
  },
  ja: {
    "fixture-sheet": {
      name: "フィクスチャシート",
      prompt: "(💡 先にスケッチを生成し、スタイル枠に選んでください)[📎 正面] と [📎 背面] の [📎 キャラクター] を一枚に並べて描く。",
      node: {
        sketch: { name: "スケッチ", prompt: "[📎 キャラクター] が [📎 ポーズ] の姿勢をとるラフスケッチ、[📎 パレット] の色で。" },
        palette: { name: "パレット" },
      },
      input: {
        pose: { name: "ポーズ", note: "先にポーズにポーズ画像を入れてください" },
        front: { name: "正面", note: "先に正面に正面の画像を入れてください" },
        back: { name: "背面", note: "先に背面に背面の画像を入れてください" },
        character: { name: "キャラクター", note: "先にキャラクターにキャラクターを入れてください" },
      },
      step: {
        split: "フィクスチャシートの生成後、右クリックしてツールからグリッド分割を選ぶ",
        pick: "気に入ったパネルを新しいノードにドラッグする",
      },
    },
    "fixture-solo": {
      name: "フィクスチャ単体",
      prompt: "[📎 参照] を水彩画に描き直す。",
      input: { reference: { name: "参照", note: "先に参照に画像を入れてください" } },
    },
    "fixture-steps": {
      name: "フィクスチャ手順",
      prompt: "夜明けの灯台。",
      step: { upscale: "生成後、ツールからアップスケールする" },
    },
    "fixture-shots": {
      name: "フィクスチャショット",
      prompt: "(💡 先にスチルを生成してください)[📎 スチル] が海岸を歩く。",
      node: { still: { name: "スチル", prompt: "黄色いコートの女性。" } },
    },
  },
};

/** The locales the fixtures have words in. */
export const FIXTURE_LOCALES = Object.keys(STRINGS);

/**
 * Load the real catalogs and lay the fixtures' strings over `canvas.template`
 * in each locale that has them. `loadLocales()` alone restores the catalogs.
 */
export function loadFixtureLocales(): void {
  loadLocales();
  for (const [locale, strings] of Object.entries(STRINGS)) {
    const messages = JSON.parse(readFileSync(resolve(MONOREPO_ROOT, "locales", `${locale}.json`), "utf-8")) as {
      canvas: { template: Record<string, unknown> };
    };
    messages.canvas.template = { ...messages.canvas.template, ...strings };
    setLocaleMessages(locale, messages);
  }
}

/** Where each identity sits in a proposal: `node:<key>`, `input:<key>` or `guide`. */
export type Identities = Map<string, number>;

/** The agent's proposal for a template, and where each identity sits in it. */
export interface AgentShape {
  sent: Sent;
  at: Identities;
}

/**
 * The proposal the agent sends for one template (design 6.9 "Agent shape"),
 * built from `templateSkeleton`: one node per key carrying `template: { id,
 * key }` (the anchor's key written or left out), one empty source node per
 * input wired into the nodes it feeds, the template edges, each generate
 * node's locale prompt with each reference mark bound by name to a ref, and
 * each input's note as a note on top of every node it feeds. No guide node.
 * @param template - The template.
 * @param options - `anchorKey`: write the anchor's key; `tagInputs`: tag each input node with `{ id, input }`.
 * @returns The proposal and where each identity sits.
 */
export function agentShape(template: GenerationTemplate, options: { anchorKey?: boolean; tagInputs?: boolean } = {}): AgentShape {
  const skeleton = templateSkeleton(template);
  const base = `canvas.template.${template.id}`;
  const nodes: SentNode[] = [];
  const at: Identities = new Map();
  const names = new Map<string, string>();
  for (const [key, node] of skeleton.nodes) {
    const anchor = key === skeleton.anchor;
    const name = anchor ? t(`${base}.name`) : t(`${base}.node.${key}.name`);
    names.set(`node:${key}`, name);
    at.set(`node:${key}`, nodes.length);
    const tag = anchor && options.anchorKey !== true ? { id: template.id } : { id: template.id, key };
    nodes.push({ role: node.role, type: node.type, name, template: tag } as SentNode);
  }
  for (const input of skeleton.inputs) {
    const name = t(`${base}.input.${input.key}.name`);
    names.set(`input:${input.key}`, name);
    at.set(`input:${input.key}`, nodes.length);
    nodes.push({
      role: "source",
      type: input.type,
      name,
      ...(options.tagInputs === true ? { template: { id: template.id, input: input.key } } : {}),
    } as SentNode);
  }
  const index = (identity: string): number => at.get(identity) as number;
  const edges: Sent["edges"] = [
    ...skeleton.edges.map((edge) => ({
      fromIndex: index(`node:${edge.from}`),
      toIndex: index(`node:${edge.to}`),
      ...(edge.into === undefined ? {} : { into: edge.into }),
    })),
    ...skeleton.inputs.flatMap((input) =>
      input.feeds.map((fed) => ({ fromIndex: index(`input:${input.key}`), toIndex: index(`node:${fed}`), into: "pool" })),
    ),
  ];
  for (const [key, node] of skeleton.nodes) {
    if (node.role !== "generate") continue;
    const words = key === skeleton.anchor ? t(`${base}.prompt`) : t(`${base}.node.${key}.prompt`);
    const fedBy = skeleton.inputs.filter((input) => input.feeds.includes(key));
    const targets = new Map<string, number>([
      ...fedBy.map((input): [string, number] => [names.get(`input:${input.key}`) as string, index(`input:${input.key}`)]),
      ...skeleton.edges
        .filter((edge) => edge.to === key && (edge.into === undefined || edge.into === "pool"))
        .map((edge): [string, number] => [names.get(`node:${edge.from}`) as string, index(`node:${edge.from}`)]),
    ]);
    const notes = fedBy.map((input) => ({ slot: { kind: "note" as const, label: t(`${base}.input.${input.key}.note`) } }));
    const prompt = [...notes, ...markedSegments(words).map((segment) => sentSegment(segment, targets))];
    const at_ = index(`node:${key}`);
    nodes[at_] = { ...(nodes[at_] as SentNode), prompt };
  }
  return { sent: { nodes, edges, rationale: "Start from the template.", groupName: "Template test" }, at };
}

/**
 * One segment of a template's locale prompt as the agent sends it: a
 * reference mark becomes the ref of the node whose name is its label.
 * @param segment - The segment.
 * @param targets - Name to index of every node the prompt may @.
 * @returns The segment as sent.
 * @throws {Error} A mark naming no target, which the fixture would never hold.
 */
function sentSegment(segment: PromptSegment, targets: ReadonlyMap<string, number>): NonNullable<SentNode["prompt"]>[number] {
  const slot = segment.slot;
  if (slot === undefined) return { text: segment.text ?? "" };
  if (slot.kind === "asset") {
    const ref = targets.get(slot.label);
    if (ref === undefined) throw new Error(`no target named "${slot.label}"`);
    return { ref };
  }
  return slot.kind === "tweak" ? { slot: { kind: "tweak", label: slot.label, note: slot.note } } : { slot: { kind: "note", label: slot.label } };
}

/**
 * A segment list with every ref renumbered and refs to removed nodes dropped.
 * @param segments - The segments.
 * @param renumber - Old index to new index, or undefined for a removed node.
 * @param dropNote - A note label to drop as well, or none.
 * @returns The segments.
 */
function renumbered(
  segments: NonNullable<SentNode["prompt"]>,
  renumber: (index: number) => number | undefined,
  dropNote?: string,
): NonNullable<SentNode["prompt"]> {
  return segments.flatMap((segment) => {
    if ("ref" in segment) {
      const to = renumber(segment.ref);
      return to === undefined ? [] : [{ ref: to }];
    }
    if ("slot" in segment && segment.slot.kind === "note" && segment.slot.label === dropNote) return [];
    return [segment];
  });
}

/**
 * The shape with one node taken out: its edges and the refs to it go, the
 * nodes after it move up one, and a note label given goes from every prompt.
 * @param shape - The shape.
 * @param identity - The node's identity.
 * @param dropNote - A note label to drop with it, or none.
 * @returns The shape without it.
 */
export function withoutNode(shape: AgentShape, identity: string, dropNote?: string): AgentShape {
  const gone = shape.at.get(identity) as number;
  const renumber = (index: number): number | undefined => (index === gone ? undefined : index > gone ? index - 1 : index);
  const at: Identities = new Map([...shape.at].flatMap(([id, index]): [string, number][] => (id === identity ? [] : [[id, renumber(index) as number]])));
  const nodes = shape.sent.nodes
    .filter((_, index) => index !== gone)
    .map((node) => (node.prompt === undefined ? node : { ...node, prompt: renumbered(node.prompt, renumber, dropNote) }));
  const edges = shape.sent.edges
    .filter((edge) => edge.fromIndex !== gone && edge.toIndex !== gone)
    .map((edge) => ({ ...edge, fromIndex: renumber(edge.fromIndex) as number, toIndex: renumber(edge.toIndex) as number }));
  return { sent: { ...shape.sent, nodes, edges }, at };
}

/**
 * The shape with the edge between two identities taken out, and the refs the
 * receiving node makes to the sender with it.
 * @param shape - The shape.
 * @param from - The sender's identity.
 * @param to - The receiver's identity.
 * @param dropNote - A note label on the receiver to drop as well, or none.
 * @returns The shape without the edge.
 */
export function withoutEdge(shape: AgentShape, from: string, to: string, dropNote?: string): AgentShape {
  const fromIndex = shape.at.get(from) as number;
  const toIndex = shape.at.get(to) as number;
  const nodes = shape.sent.nodes.map((node, index) =>
    index !== toIndex || node.prompt === undefined ? node : { ...node, prompt: renumbered(node.prompt, (i) => (i === fromIndex ? undefined : i), dropNote) },
  );
  const edges = shape.sent.edges.filter((edge) => edge.fromIndex !== fromIndex || edge.toIndex !== toIndex);
  return { sent: { ...shape.sent, nodes, edges }, at: shape.at };
}

/**
 * Two shapes in one proposal, the second's indices after the first's.
 * @param first - The first shape.
 * @param second - The second shape.
 * @returns The proposal.
 */
export function joined(first: Sent, second: Sent): Sent {
  const offset = first.nodes.length;
  const shift = (index: number): number => index + offset;
  return {
    ...first,
    nodes: [
      ...first.nodes,
      ...second.nodes.map((node) => (node.prompt === undefined ? node : { ...node, prompt: renumbered(node.prompt, shift) })),
    ],
    edges: [...first.edges, ...second.edges.map((edge) => ({ ...edge, fromIndex: shift(edge.fromIndex), toIndex: shift(edge.toIndex) }))],
  };
}

/**
 * Identity of each index, the inverse of {@link Identities}.
 * @param at - Where each identity sits.
 * @returns Index to identity.
 */
export function identityOf(at: Identities): Map<number, string> {
  return new Map([...at].map(([identity, index]) => [index, identity]));
}
