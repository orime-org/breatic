// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How to write a template's prompts well (inner#1807), handed to the agent
 * with the template it reads. The craft is shared by every template of a kind,
 * so it is written once here and joined to a template by the node types it
 * generates and the goal it serves, rather than repeated in each template.
 */

import type { GenerationTemplate } from "@breatic/shared";

/** The craft sections, each one paragraph the agent reads. */
export const TEMPLATE_CRAFT = {
  picture:
    "Craft for a picture or a video: say what each reference is for, what to take from it and what not to inherit; " +
    "repeat 3 to 6 identifying features word for word and write every count as a number; name concrete light " +
    "sources and materials, never empty words such as cinematic or 8K; put no text in the picture unless the template asks for it (labels, a title, lines of verse); write what " +
    "can be seen happening, not what someone feels inside.",
  video:
    "Craft for video: the first frame is already the finished picture and already moving, with a hook within " +
    "2 seconds; timecodes are whole seconds, continuous, not overlapping and adding up to the duration, with a " +
    "visible beat every 2 to 3 seconds unless the template sets its own cut rhythm; one main camera move per shot, with its start, direction and end and " +
    "what stays still; one light source logic; sound in layers, saying where silence falls.",
  audio:
    "Craft for sound: for music, name the genre, the BPM, the key, 2 to 3 instruments and how the energy rises " +
    "and falls, except what the template takes from a reference picture, video or song, and say it is instrumental " +
    "when no one sings; for a voice, give the line to be said exactly as written and nothing more, with its pace, " +
    "where it pauses and breathes, recorded dry with no music or room under it; for sound effects, each sound in its " +
    "own phrase, saying how near or far it is and how sparse or dense, and how the layers sit together (a bed may hold several).",
  character:
    "Craft for a character: keep the reference's rendering (a 3D render stays 3D, a drawing stays a drawing) unless " +
    "the prompt names another style.",
} as const;

/**
 * The craft that fits one template, by what its generate nodes make: the
 * picture craft for a picture or a video, video's for a video, sound's for a
 * sound (inner#1825), and a character's when it serves the character goal.
 * @param template - The template.
 * @returns The sections joined, one paragraph each.
 * @throws {never} Never.
 */
export function templateCraft(template: GenerationTemplate): string {
  const makes = new Set(template.nodes.flatMap((node) => (node.role === "generate" ? [node.type] : [])));
  return [
    ...(makes.has("image") || makes.has("video") ? [TEMPLATE_CRAFT.picture] : []),
    ...(makes.has("video") ? [TEMPLATE_CRAFT.video] : []),
    ...(makes.has("audio") ? [TEMPLATE_CRAFT.audio] : []),
    ...(template.goal === "character" ? [TEMPLATE_CRAFT.character] : []),
  ].join("\n\n");
}
