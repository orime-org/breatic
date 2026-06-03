// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Type definitions for understand model families.
 *
 * Understand uses two distinct model family interfaces:
 * - LLM families export `buildMessages()` for vi/vv/va modes
 * - ASR families export `buildRequest()` for transcribe mode
 */

/** LLM-based model family (vi/vv/va) -- builds multimodal messages. */
export interface UnderstandModelFamily {
  readonly MODELS: ReadonlySet<string>;
  buildMessages(
    prompt: string,
    modelName: string,
    params: Record<string, unknown>,
  ): Promise<[Array<{ role: string; content: unknown[] }>, number]>;
}

/** ASR-based model family (transcribe) -- builds request params. */
export interface UnderstandAsrFamily {
  readonly MODELS: ReadonlySet<string>;
  buildRequest(
    prompt: string,
    modelName: string,
    params: Record<string, unknown>,
  ): Promise<[string, Record<string, unknown>]>;
}

/** Union type for any understand model family. */
export type AnyUnderstandFamily = UnderstandModelFamily | UnderstandAsrFamily;

/**
 * Type guard: checks if a family is an LLM family with `buildMessages`.
 * @param family - The understand family to test
 * @returns True when the family exposes `buildMessages` (an LLM family)
 */
export function isLlmFamily(family: AnyUnderstandFamily): family is UnderstandModelFamily {
  return "buildMessages" in family;
}

/**
 * Type guard: checks if a family is an ASR family with `buildRequest`.
 * @param family - The understand family to test
 * @returns True when the family exposes `buildRequest` (an ASR family)
 */
export function isAsrFamily(family: AnyUnderstandFamily): family is UnderstandAsrFamily {
  return "buildRequest" in family;
}
