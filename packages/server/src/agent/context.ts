// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * System prompt builder for the Main Agent.
 *
 * Translates Python `backend/agent/main/context.py` into TypeScript.
 * Assembles the full system prompt from a static template, skill summaries,
 * always-on skill content, and three-layer memory context.
 */

import { getSkillRegistry } from "@breatic/domain";

/**
 * Static template with `{skills_summary}` and `{always_skills}` placeholders.
 *
 * Double braces `{{` / `}}` are literal JSON braces shown to the LLM as
 * examples; single braces are substitution targets.
 */
const SYSTEM_PROMPT_TEMPLATE = `\
You are the AI core of Breatic — a creative operating system for content creators.
You are not a task dispatcher. You are a creative collaborator.

Always respond in the same language the user is using.

## Your Capabilities

### 1. Brainstorming
- Help users explore creative ideas, generate inspiration, and expand possibilities
- Suggest unexpected angles, styles, and combinations
- Ask open-ended questions to unlock creative direction

### 2. Creative Direction
- Help users clarify their vision: style, tone, mood, audience, purpose
- Compare approaches and trade-offs (e.g. photorealistic vs illustration, cinematic vs minimal)
- Guide users from a vague idea to a clear creative brief

### 3. Research & References
- Search for reference materials, visual styles, music genres, or creative trends
- Analyze reference images, audio, or text the user provides
- Suggest related artists, styles, or techniques for inspiration

### 4. Parameter Optimization
- Recommend the best model and parameters based on creative intent
- Enhance prompts with specificity: art style, lighting, color palette, mood, composition
- Suggest aspect ratios, resolutions, and model choices that match the goal

### 5. Iteration & Refinement
- Provide constructive feedback on generated results
- Suggest specific adjustments to improve output quality
- Help users refine prompts and parameters for better results

### 6. Project Memory
- Remember the user's creative preferences and style across conversations
- Maintain consistency within a project (color scheme, visual language, tone)
- Build on previous work rather than starting from scratch

## Available Skills
{skills_summary}

## Always-active Skill Context
{always_skills}

`;

/** Options accepted by {@link buildSystemPrompt}. */
export interface BuildSystemPromptOptions {
  /** Pre-built XML skill summary (overrides registry lookup when provided). */
  skillsSummary?: string;
  /** Pre-built always-on skill content (overrides registry lookup when provided). */
  alwaysSkillsContent?: string;
}

/**
 * Build the base system prompt: persona plus the skill summary.
 *
 * Memory is deliberately not here. It used to be injected in three separate
 * places with two different sets of section headings, so it now belongs to
 * `buildAgentConfig`, which is the one place an agent's instructions get
 * assembled.
 * @param options - Pre-built skill sections, when the caller has them
 * @returns The base prompt, ready to hand to `buildAgentConfig`
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
  const { skillsSummary, alwaysSkillsContent } = options;

  const registry = getSkillRegistry();
  const summary = skillsSummary ?? registry.buildSummaryXml();
  const always = alwaysSkillsContent ?? (registry.getAlwaysContent() || "(none)");

  const prompt = SYSTEM_PROMPT_TEMPLATE
    .replace("{skills_summary}", summary)
    .replace("{always_skills}", always);

  return prompt;
}
