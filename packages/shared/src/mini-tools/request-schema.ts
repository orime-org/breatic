// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The body of `POST /mini-tools`, generated from the registry (inner#888
 * §6.1). One member per tool the server runs, discriminated by `tool`. A
 * model tool's params accept exactly the keys its panel exposes; the values
 * are checked against the pinned model's catalog entry by the server, which
 * holds the catalog.
 */

import { z } from "zod";

import { ADJUST_RANGES } from "@shared/adjust-value.js";
import { DYNAMICS_PRESETS, DYNAMICS_RANGES, type DynamicsPreset } from "@shared/audio-dynamics.js";
import { EQ_BANDS_HZ, EQ_GAIN_RANGE, EQ_PRESETS, type EqPreset } from "@shared/audio-eq.js";
import { isModelTool } from "@shared/mini-tools/derive.js";
import { mostOutputsOf, outputsOf } from "@shared/mini-tools/outputs.js";
import { MINI_TOOLS } from "@shared/mini-tools/tools.js";
import type { MiniToolParam, MiniToolSpec } from "@shared/mini-tools/types.js";

const URL_SCHEMA = z.string().url().max(2048);

const SLOT_VALUE = z.object({
  url: URL_SCHEMA,
  duration: z.number().nonnegative().optional(),
});

/**
 * The value schema of one declared param.
 * @param param - The param.
 * @param cellsCap - How many cells the tool's grid holds at its largest.
 * @returns Its zod schema.
 */
function paramSchema(param: MiniToolParam, cellsCap: number): z.ZodType {
  switch (param.kind) {
    case "number":
      return z.number().min(param.min).max(param.max);
    case "enum":
      return z.enum(param.options.map((option) => option.value) as [string, ...string[]]);
    case "rect":
      return z
        .object({
          x: z.number().nonnegative(),
          y: z.number().nonnegative(),
          w: z.number().positive(),
          h: z.number().positive(),
        })
        .nullable();
    case "range":
      return z
        .object({ start: z.number().nonnegative(), end: z.number().positive() })
        .refine((range) => range.end > range.start);
    case "adjust":
      return z.strictObject(
        Object.fromEntries(
          Object.entries(ADJUST_RANGES).map(([name, range]) => [name, z.number().min(range.min).max(range.max)]),
        ),
      );
    case "orient":
      return z.object({ turns: z.number().int(), flipX: z.boolean(), flipY: z.boolean() });
    case "list":
      return z.array(z.number().min(param.item.min).max(param.item.max)).max(param.maxItems);
    case "cells":
      return z.array(z.number().int().nonnegative()).max(cellsCap);
    case "toggle":
      return z.boolean();
    case "eq":
      return z.strictObject({
        preset: z.enum([...(Object.keys(EQ_PRESETS) as EqPreset[]), "custom"]),
        gains: z.array(z.number().min(EQ_GAIN_RANGE.min).max(EQ_GAIN_RANGE.max)).length(EQ_BANDS_HZ.length),
      });
    case "dynamics":
      return z.strictObject({
        preset: z.enum([...(Object.keys(DYNAMICS_PRESETS) as DynamicsPreset[]), "custom"]),
        ...Object.fromEntries(
          Object.entries(DYNAMICS_RANGES).map(([field, range]) => [field, z.number().min(range.min).max(range.max)]),
        ),
      });
  }
}

/**
 * The params schema of one tool.
 * @param spec - The tool.
 * @returns A strict object over exactly the tool's keys.
 */
function paramsSchema(spec: MiniToolSpec): z.ZodType {
  if (isModelTool(spec)) {
    return z.strictObject(Object.fromEntries(spec.params.map((param) => [param.key, z.unknown().optional()])));
  }
  const cellsCap = mostOutputsOf(spec);
  return z.strictObject(Object.fromEntries(spec.params.map((param) => [param.key, paramSchema(param, cellsCap)])));
}

/**
 * The slots schema of one tool. Whether a slot may stay empty is the yaml's
 * `optional`; the panel holds Run until every required slot is filled.
 * @param spec - The tool.
 * @returns A strict object over the tool's slot keys.
 */
function slotsSchema(spec: MiniToolSpec): z.ZodType {
  return z.strictObject(
    Object.fromEntries(
      spec.slots.map((slot) => [slot.key, (slot.many ? z.array(SLOT_VALUE) : SLOT_VALUE).optional()]),
    ),
  );
}

/**
 * The drawing field of one tool: what was uploaded from what the reader drew
 * — a mask tool's mask, a sketch tool's composite — required on a tool that
 * draws and absent everywhere else.
 * @param spec - The tool.
 * @returns The shape to add to its member, empty for a tool without a drawing.
 */
function drawingShape(spec: MiniToolSpec): Record<string, z.ZodType> {
  if (spec.drawing === undefined) return {};
  return {
    drawing:
      spec.drawing.kind === "mask"
        ? z.strictObject({ mask: URL_SCHEMA })
        : z.strictObject({ image: URL_SCHEMA }),
  };
}

/**
 * The request member of one server-run tool, before its node count is checked.
 * @param spec - The tool.
 * @returns Its strict object schema.
 */
function memberObject(spec: MiniToolSpec): z.ZodObject {
  return z.strictObject({
    tool: z.literal(spec.id),
    project_id: z.string().uuid(),
    space_id: z.string().uuid(),
    node_ids: z.array(z.string().uuid()),
    source: z.object({
      url: URL_SCHEMA,
      mime_type: z.string().max(255).optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      duration: z.number().nonnegative().optional(),
    }),
    prompt: z.string().optional(),
    params: paramsSchema(spec),
    slots: slotsSchema(spec),
    ...drawingShape(spec),
    ...(spec.expand === undefined
      ? {}
      : { expand: z.strictObject({ image: URL_SCHEMA, mask: URL_SCHEMA }) }),
  });
}

/** One picked piece of media as the request carries it. */
export interface MiniToolRequestSlot {
  url: string;
  duration?: number | undefined;
}

/** A validated `POST /mini-tools` body. */
export interface MiniToolRequest {
  tool: string;
  project_id: string;
  space_id: string;
  node_ids: string[];
  source: {
    url: string;
    mime_type?: string | undefined;
    width?: number | undefined;
    height?: number | undefined;
    duration?: number | undefined;
  };
  prompt?: string | undefined;
  params: Record<string, unknown>;
  slots: Record<string, MiniToolRequestSlot | MiniToolRequestSlot[] | undefined>;
  /**
   * What was uploaded from the reader's drawing, on a tool that draws: a mask
   * tool's mask, or a sketch tool's composite.
   */
  drawing?: { mask: string } | { image: string } | undefined;
  /** An expand tool's padded picture and the mask of its new area. */
  expand?: { image: string; mask: string } | undefined;
}

/**
 * Reports a request whose node ids do not number the results its params make.
 * @param spec - The tool.
 * @param body - The parsed member.
 * @param body.node_ids - The result nodes.
 * @param body.params - The run's params.
 * @param ctx - The refinement context.
 */
function checkNodeCount(
  spec: MiniToolSpec,
  body: { node_ids: string[]; params: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  const expected = outputsOf(spec, body.params).length;
  if (body.node_ids.length !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["node_ids"],
      message: `expected ${expected} node ids`,
    });
  }
}

/**
 * The request member of one server-run tool, its node count checked against
 * the results its params make.
 * @param spec - The tool.
 * @returns The schema.
 */
export function miniToolRequestMemberSchema(spec: MiniToolSpec): z.ZodType {
  return memberObject(spec).superRefine((body, ctx) =>
    checkNodeCount(spec, body as { node_ids: string[]; params: Record<string, unknown> }, ctx),
  );
}

const SERVER_TOOLS = MINI_TOOLS.filter((spec) => spec.run.kind !== "browser");
const SERVER_TOOL_BY_ID = new Map(SERVER_TOOLS.map((spec) => [spec.id, spec]));

// The members are generated from the registry at load time, so zod cannot
// infer the body's shape; MiniToolRequest states it.
export const miniToolRequestSchema = z.discriminatedUnion(
  "tool",
  SERVER_TOOLS.map(memberObject) as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]],
).superRefine((body, ctx) => {
  const member = body as { tool: string; node_ids: string[]; params: Record<string, unknown> };
  const spec = SERVER_TOOL_BY_ID.get(member.tool);
  if (spec) checkNodeCount(spec, member, ctx);
}) as unknown as z.ZodType<MiniToolRequest>;
