// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The facts a video tool panel reads beyond its draft (inner#1306): the quote debounce and the output cap from
 * `GET /canvas/limits`.
 */
import { useQuery } from '@tanstack/react-query';
import type { VideoToolId } from '@breatic/shared/mini-tools';
import { canvasLimitsQuery } from '@web/data/api/canvas';

/** What the panel reads of its tool's limits. */
export interface VideoToolModels {
  /** How long the priced inputs hold still before the panel asks for a quote (config `quote_debounce_ms`). */
  quoteDebounceMs: number;
  /** The most outputs one run of this tool creates (config `executions[tool].max_outputs`), absent while unknown. */
  maxOutputs?: number;
}

/**
 * Read the limits for an open video tool.
 * @param args - The panel.
 * @param args.toolId - The tool.
 * @returns The facts.
 * @throws {never} Never.
 */
export function useVideoToolModels(args: { toolId: VideoToolId }): VideoToolModels {
  const { toolId } = args;
  const limits = useQuery({ ...canvasLimitsQuery(), enabled: toolId === 'video.split' }).data;
  return { quoteDebounceMs: limits?.quoteDebounceMs ?? 0, ...(limits?.maxOutputs?.[toolId] === undefined ? {} : { maxOutputs: limits.maxOutputs[toolId] }) };
}
