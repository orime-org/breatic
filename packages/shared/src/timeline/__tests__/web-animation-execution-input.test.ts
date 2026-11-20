// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The three web-animation execution kinds (#1490 design §4.1): the request a client submits, the input acceptance
 * freezes and the one reader of a stored row's input. The `kind` lives in the row's column, never in its `input`.
 */

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  WebAnimationExecutionInputSchema, WebAnimationExecutionRequestSchema, executionInputOf,
} from "../web-animation.js";

const SPACE = "22222222-2222-4222-8222-222222222222";
const ACTION = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const FPS = { num: 24, den: 1 };

describe("WebAnimationExecutionRequestSchema", () => {
  it("reads a create request as made in a Motion Space", () => {
    const body = { spaceId: SPACE, actionId: ACTION, kind: "web_animation_create", prompt: "A logo", engine: "deepseek", aspect: "16:9", durationSeconds: 4 };
    expect(WebAnimationExecutionRequestSchema.parse(body)).toEqual({ ...body, origin: "web_animation_space" });
  });

  it("reads a modify request with the base version, its instruction and the new aspect and duration", () => {
    const body = {
      spaceId: SPACE, actionId: ACTION, kind: "web_animation_modify", baseSourceVersionId: VERSION, instruction: "Slower",
      engine: "deepseek", aspect: "9:16", durationSeconds: 6,
    };
    expect(WebAnimationExecutionRequestSchema.parse(body)).toEqual({ ...body, origin: "web_animation_space" });
  });

  it("reads an export request that names only its source version", () => {
    const body = { spaceId: SPACE, actionId: ACTION, kind: "web_animation_export", sourceVersionId: VERSION };
    expect(WebAnimationExecutionRequestSchema.parse(body)).toEqual({ ...body, origin: "web_animation_space" });
  });

  it("refuses a request without a kind", () => {
    const body = { spaceId: SPACE, actionId: ACTION, prompt: "A logo", engine: "deepseek", aspect: "1:1", durationSeconds: 3 };
    expect(WebAnimationExecutionRequestSchema.safeParse(body).success).toBe(false);
    expect(WebAnimationExecutionRequestSchema.safeParse({ ...body, fps: FPS }).success).toBe(false);
  });

  it("refuses a frame rate on a request that names its kind", () => {
    const body = { spaceId: SPACE, actionId: ACTION, kind: "web_animation_create", prompt: "A", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: FPS };
    expect(WebAnimationExecutionRequestSchema.safeParse(body).success).toBe(false);
  });

  it("refuses a field from another kind", () => {
    const body = { spaceId: SPACE, actionId: ACTION, kind: "web_animation_export", sourceVersionId: VERSION, prompt: "A" };
    expect(WebAnimationExecutionRequestSchema.safeParse(body).success).toBe(false);
  });

  it("refuses a modify request without its base version", () => {
    const body = { spaceId: SPACE, actionId: ACTION, kind: "web_animation_modify", instruction: "Slower", engine: "deepseek", aspect: "9:16", durationSeconds: 6 };
    expect(WebAnimationExecutionRequestSchema.safeParse(body).success).toBe(false);
  });

  it("refuses an unknown kind", () => {
    const body = { spaceId: SPACE, actionId: ACTION, kind: "web_animation_delete", sourceVersionId: VERSION };
    expect(WebAnimationExecutionRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("WebAnimationExecutionInputSchema", () => {
  it("accepts each kind's frozen input", () => {
    const create = { kind: "web_animation_create", prompt: "A", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: FPS };
    const modify = { kind: "web_animation_modify", baseSourceVersionId: VERSION, instruction: "B", engine: "deepseek", aspect: "9:16", durationSeconds: 6, fps: FPS };
    const exported = { kind: "web_animation_export", sourceVersionId: VERSION, width: 1920, height: 1080, fps: FPS, durationFrames: 96, videoKey: "generated/2026/11/15/a.mp4" };
    expect(WebAnimationExecutionInputSchema.parse(create)).toEqual(create);
    expect(WebAnimationExecutionInputSchema.parse(modify)).toEqual(modify);
    expect(WebAnimationExecutionInputSchema.parse(exported)).toEqual(exported);
  });

  it("refuses a frozen create without its frame rate", () => {
    expect(WebAnimationExecutionInputSchema.safeParse({ kind: "web_animation_create", prompt: "A", engine: "deepseek", aspect: "16:9", durationSeconds: 4 }).success).toBe(false);
  });

  it("refuses an engine on a frozen export", () => {
    expect(WebAnimationExecutionInputSchema.safeParse({ kind: "web_animation_export", sourceVersionId: VERSION, engine: "deepseek", width: 1920, height: 1080, fps: FPS, durationFrames: 96, videoKey: "generated/a.mp4" }).success).toBe(false);
  });

  it("refuses a frozen export without the key its video is written to", () => {
    expect(WebAnimationExecutionInputSchema.safeParse({ kind: "web_animation_export", sourceVersionId: VERSION, width: 1920, height: 1080, fps: FPS, durationFrames: 96 }).success).toBe(false);
  });
});

describe("executionInputOf", () => {
  it("reads a stored create row, whose input carries no kind, by its kind column", () => {
    const row = { kind: "web_animation_create" as const, input: { prompt: "A", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: FPS } };
    expect(executionInputOf(row)).toEqual({ kind: "web_animation_create", ...row.input });
  });

  it("takes the kind from the column over any kind key in the input", () => {
    const row = { kind: "web_animation_export" as const, input: { kind: "web_animation_create", sourceVersionId: VERSION, width: 1080, height: 1920, fps: FPS, durationFrames: 120, videoKey: "generated/b.mp4" } };
    expect(executionInputOf(row)).toEqual({ kind: "web_animation_export", sourceVersionId: VERSION, width: 1080, height: 1920, fps: FPS, durationFrames: 120, videoKey: "generated/b.mp4" });
  });

  it("throws on a stored input that does not fit its kind", () => {
    expect(() => executionInputOf({ kind: "web_animation_modify", input: { prompt: "A" } })).toThrow(ZodError);
  });
});
