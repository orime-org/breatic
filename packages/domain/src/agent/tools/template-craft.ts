// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How to write a template's prompts well (inner#1807), handed to the agent
 * with the template it reads. The craft is shared by every template of a kind,
 * so it is written once here and joined to a template by the node types it
 * generates and the goal it serves, rather than repeated in each template.
 */

import type { GenerationTemplate } from "@breatic/shared";

/** The craft sections, each one paragraph the agent reads. */
export const TEMPLATE_CRAFT = {
  all:
    "Craft for every prompt: say what each reference is for, what to take from it and what not to inherit; " +
    "repeat 3 to 6 identifying features word for word and write every count as a number; name concrete light " +
    "sources and materials, never empty words such as cinematic or 8K; put no text in the picture; write what " +
    "can be seen happening, not what someone feels inside.",
  video:
    "Craft for video: the first frame is already the finished picture and already moving, with a hook within " +
    "2 seconds; timecodes are whole seconds, continuous, not overlapping and adding up to the duration, with a " +
    "visible beat every 2 to 3 seconds; one main camera move per shot, with its start, direction and end and " +
    "what stays still; one light source logic; sound in layers, saying where silence falls.",
  character:
    "Craft for a character: when one character appears in several pictures or videos, make a character sheet " +
    "before the shots; keep the reference's rendering (a 3D render stays 3D, a drawing stays a drawing) unless " +
    "the prompt names another style.",
} as const;

/**
 * The craft that fits one template: every prompt's, video's when it
 * generates a video, a character's when it serves the character goal.
 * @param template - The template.
 * @returns The sections joined, one paragraph each.
 * @throws {never} Never.
 */
export function templateCraft(template: GenerationTemplate): string {
  const makesVideo = template.nodes.some((node) => node.role === "generate" && node.type === "video");
  return [TEMPLATE_CRAFT.all, ...(makesVideo ? [TEMPLATE_CRAFT.video] : []), ...(template.goal === "character" ? [TEMPLATE_CRAFT.character] : [])].join("\n\n");
}
