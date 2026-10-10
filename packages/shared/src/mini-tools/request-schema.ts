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

import { defaultAdjustValue } from "@shared/adjust-value.js";
import { isModelTool } from "@shared/mini-tools/derive.js";
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
 * @returns Its zod schema.
 */
function paramSchema(param: MiniToolParam): z.ZodType {
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
        Object.fromEntries(Object.keys(defaultAdjustValue).map((name) => [name, z.number().min(-100).max(100)])),
      );
    case "orient":
      return z.object({ turns: z.number().int(), flipX: z.boolean(), flipY: z.boolean() });
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
  return z.strictObject(Object.fromEntries(spec.params.map((param) => [param.key, paramSchema(param)])));
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
 * The drawing field of one tool: the uploaded images made from what the
 * reader drew, required on a tool that draws and absent everywhere else.
 * @param spec - The tool.
 * @returns The shape to add to its member, empty for a tool without a drawing.
 */
function drawingShape(spec: MiniToolSpec): Record<string, z.ZodType> {
  if (spec.drawing === undefined) return {};
  return {
    drawing:
      spec.drawing.kind === "mask"
        ? z.strictObject({ image: URL_SCHEMA, mask: URL_SCHEMA })
        : z.strictObject({ image: URL_SCHEMA }),
  };
}

/**
 * The request member of one server-run tool.
 * @param spec - The tool.
 * @returns Its strict object schema.
 */
function memberSchema(spec: MiniToolSpec): z.ZodObject {
  return z.strictObject({
    tool: z.literal(spec.id),
    project_id: z.string().uuid(),
    space_id: z.string().uuid(),
    node_ids: z.array(z.string().uuid()).length(spec.outputs.length),
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
  /** The uploaded images made from the reader's drawing, on a tool that draws. */
  drawing?: { image: string; mask?: string | undefined } | undefined;
}

const SERVER_TOOLS = MINI_TOOLS.filter((spec) => spec.run.kind !== "browser");

// The members are generated from the registry at load time, so zod cannot
// infer the body's shape; MiniToolRequest states it.
export const miniToolRequestSchema = z.discriminatedUnion(
  "tool",
  SERVER_TOOLS.map(memberSchema) as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]],
) as unknown as z.ZodType<MiniToolRequest>;
