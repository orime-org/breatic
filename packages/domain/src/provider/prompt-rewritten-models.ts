// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The models whose prompt is rewritten on a language model when the run is opened (inner#1743). One list: the worker
 * rewrites their prompts, and the server records the key row that language-model step runs on (inner#1953). It imports
 * nothing, so a suite that mocks the rest of domain can still read the real list.
 */
export const PROMPT_REWRITTEN_MODELS: ReadonlySet<string> = new Set(["nano-banana-2"]);
