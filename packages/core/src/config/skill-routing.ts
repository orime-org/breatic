// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Which skill may be used where, and by whom.
 *
 * These three answers used to sit in each skill's own `metadata.json`, which
 * put a skill in charge of its own permissions. They are the host's decision,
 * so they live here — in one file the host owns — for two reasons:
 *
 * A third-party skill can be dropped in unchanged. Nothing is added to its
 * frontmatter, so anything following the Agent Skills format works as-is.
 *
 * And the answer stops depending on whoever wrote the skill. Routing is
 * decided by configuration the host reads, not by a claim the skill makes
 * about itself.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

/**
 * Every surface a skill can appear on.
 *
 * A closed set rather than free text, so a typo fails loudly at startup
 * instead of quietly hiding the skill everywhere — which would read as "the
 * skill is broken" rather than "the config has a typo".
 */
export const SKILL_SURFACES = [
  "chat",
  "canvas",
  "image_node",
  "video_node",
  "document",
] as const;

/**
 * One skill's routing.
 *
 * The default direction differs per axis, and that is the point. MCP Apps'
 * rule is "unset means fully open", which is right for visibility — leaving
 * one on shows an extra entry point — and wrong for authorization, where
 * leaving one on means anybody may call the thing.
 *
 * This repository has already been bitten by treating them the same: two
 * skills carried the same script-execution tool, one was explicitly gated
 * and the other was not, and the only difference between them was whether
 * someone remembered to write the line. Coupling could not prevent it even
 * when both facts sat in the same file; with them in separate files, only a
 * closed default can.
 */
const skillRouteSchema = z.object({
  /** Where the skill may appear. Visibility: open by default is harmless. */
  surfaces: z.array(z.enum(SKILL_SURFACES)).default(["chat", "canvas"]),
  /** Whether an end user may fire it directly. Authorization: closed unless said. */
  user_invocable: z.boolean().default(false),
  /** Whether the model may reach for it mid-turn. Authorization: closed unless said. */
  model_invocable: z.boolean().default(false),
});

/** The whole file. A skill absent from it is allowed nowhere. */
export const skillRoutingSchema = z.object({
  skills: z.record(z.string(), skillRouteSchema).default({}),
});

/** One skill's resolved routing. */
export type SkillRoute = z.infer<typeof skillRouteSchema>;
/** The validated routing file. */
export type SkillRouting = z.infer<typeof skillRoutingSchema>;
/** A surface a skill can appear on. */
export type SkillSurface = (typeof SKILL_SURFACES)[number];

let _cached: Readonly<SkillRouting> | null = null;

/**
 * Load and validate the skill routing config.
 *
 * Lazy like the other config readers: reading at module load would make
 * importing the barrel depend on the file being present.
 *
 * It used to take a directory "for tests", which was a lie the moment
 * anything had loaded the config first: the cache is checked before the
 * argument is read, so a test pointing at a fixture would silently get
 * whatever the shipped file said. Nothing passed it. Tests that need a
 * different document parse it with {@link skillRoutingSchema} directly.
 * @returns Frozen, validated routing for every listed skill.
 * @throws {Error} When the file is missing or fails validation.
 */
export function getSkillRouting(): Readonly<SkillRouting> {
  if (_cached) return _cached;

  const raw = readFileSync(
    resolve(MONOREPO_ROOT, "config", "skill-routing.yaml"),
    "utf-8",
  );
  _cached = Object.freeze(skillRoutingSchema.parse(parse(raw) as unknown));
  return _cached;
}

/**
 * Drop the cached routing, so the next read opens the file again.
 *
 * Not for loading a different document — there is no longer a way to point
 * this at one, and a test that needs a different one parses it with
 * {@link skillRoutingSchema} directly. This is so a test that read the
 * shipped file does not leave that read cached for the next one.
 */
export function resetSkillRouting(): void {
  _cached = null;
}
