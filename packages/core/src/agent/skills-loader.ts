/**
 * Skill registry with progressive loading.
 *
 * Translates Python `backend/agent/skills_loader.py` into TypeScript.
 * Scans the built-in `skills/` directory at startup, parses SKILL.md
 * frontmatter + metadata.json, and provides XML summaries, always-on
 * content, and on-demand skill content with dynamic model/mode injection.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { SkillMeta } from "@breatic/shared";
import { MONOREPO_ROOT } from "@core/config/env.js";
import { getRawEnvVar } from "@core/config/runtime.js";

// ── Paths ───────────────────────────────────────────────────────────

const BUILTIN_SKILLS_DIR = resolve(MONOREPO_ROOT, "skills");
const MODES_CONFIG_PATH = resolve(MONOREPO_ROOT, "config/models/modes.yaml");

// ── Internal skill metadata (superset of shared SkillMeta) ──────────

/** Extended metadata tracked internally but not exposed via the shared type. */
interface InternalSkillMeta extends SkillMeta {
  /** Scope: where this skill can be used ("agent", "canvas", or both). */
  scope: string[];
  /** Whether the skill content is always included in the system prompt. */
  always: boolean;
  /** If true, only the user can invoke this skill (hidden from LLM). */
  disableModelInvocation: boolean;
  /** Whether the skill appears in the user menu. */
  userInvocable: boolean;
  /** System binaries that must be on PATH. */
  requiresBins: string[];
  /** Environment variables that must be set. */
  requiresEnv: string[];
}

// ── SkillRegistry ───────────────────────────────────────────────────

/**
 * Registry for built-in skills with progressive loading.
 *
 * Progressive loading strategy:
 * - `buildSummaryXml()` -- name + description only (always in system prompt)
 * - `loadSkillContent()` -- full SKILL.md body (when LLM decides to use)
 * - `loadSkillFile()` -- references or other support files (on demand)
 */
export class SkillRegistry {
  private skills: Map<string, InternalSkillMeta> = new Map();

  /**
   * Create a new SkillRegistry and load all built-in skills from disk.
   *
   * @param skillsDir - Override the built-in skills directory path
   */
  constructor(private readonly skillsDir: string = BUILTIN_SKILLS_DIR) {
    this.loadBuiltin();
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Look up a skill by name.
   *
   * @param name - The unique skill name
   * @returns The SkillMeta if found, or undefined
   */
  get(name: string): SkillMeta | undefined {
    return this.skills.get(name);
  }

  /**
   * Whether the given skill may be invoked by an end user via
   * `/chat/skill`. Skills with `user_invocable: false` (e.g.
   * `skill_creator`, which grants file-system tools) must be blocked
   * from direct user invocation to prevent authenticated file-read /
   * file-write / RCE attacks. Returns `false` for unknown skills.
   *
   * @param name - The unique skill name
   * @returns Whether an authenticated user may call this skill
   */
  canUserInvoke(name: string): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    return (skill as InternalSkillMeta).userInvocable;
  }

  /**
   * Return all registered skills (user-invocable by default).
   *
   * @returns An array of SkillMeta objects
   */
  list(): SkillMeta[] {
    const result: SkillMeta[] = [];
    for (const s of this.skills.values()) {
      if (s.userInvocable) {
        result.push(s);
      }
    }
    return result;
  }

  /**
   * Return all skills matching the given category.
   *
   * @param category - The category to filter by (e.g. "image", "video")
   * @returns An array of matching SkillMeta objects
   */
  listByCategory(category: string): SkillMeta[] {
    const result: SkillMeta[] = [];
    for (const s of this.skills.values()) {
      if (s.category === category) {
        result.push(s);
      }
    }
    return result;
  }

  /**
   * Return all skills matching the given scope.
   *
   * @param scope - "agent" or "canvas"
   * @returns An array of matching SkillMeta objects
   */
  listByScope(scope: string): SkillMeta[] {
    const result: SkillMeta[] = [];
    for (const s of this.skills.values()) {
      if ((s as InternalSkillMeta).scope.includes(scope)) {
        result.push(s);
      }
    }
    return result;
  }

  /**
   * Return skills matching both scope and category.
   *
   * @param scope - "agent" or "canvas"
   * @param category - Category filter (e.g. "image")
   * @returns Filtered SkillMeta array
   */
  listByScopeAndCategory(scope: string, category: string): SkillMeta[] {
    const result: SkillMeta[] = [];
    for (const s of this.skills.values()) {
      const internal = s as InternalSkillMeta;
      if (internal.scope.includes(scope) && s.category === category) {
        result.push(s);
      }
    }
    return result;
  }

  // ── Summary (Level 1 — always in system prompt) ─────────────────

  /**
   * Build an XML summary of all available skills for the system prompt.
   *
   * Only includes name and description; full content is loaded on demand
   * via {@link loadSkillContent}.
   *
   * @returns An XML string listing each skill with its availability status
   */
  buildSummaryXml(): string {
    const lines: string[] = ["<available_skills>"];
    for (const skill of this.skills.values()) {
      if (skill.disableModelInvocation) continue;
      const avail = checkAvailability(skill);
      lines.push(
        `  <skill name="${skill.name}" available="${String(avail)}"` +
          ` always="${String(skill.always)}">` +
          `${skill.description}` +
          `</skill>`,
      );
    }
    lines.push("</available_skills>");
    return lines.join("\n");
  }

  /**
   * Return concatenated SKILL.md bodies for all always-on skills.
   *
   * @returns A string with all always-on skill content joined by horizontal rules
   */
  getAlwaysContent(): string {
    const parts: string[] = [];
    for (const skill of this.skills.values()) {
      if (!skill.always) continue;
      const content = this.readBuiltinBody(skill.name);
      if (content) {
        parts.push(`## Skill: ${skill.name}\n${content}`);
      }
    }
    return parts.join("\n\n---\n\n");
  }

  // ── Content loading (Level 2 — on demand) ───────────────────────

  /**
   * Load the full SKILL.md body for a skill.
   *
   * Strips YAML frontmatter and returns only the Markdown body.
   * For dynamic skills (e.g. `generate_image_plan`), replaces
   * `{available_models}` and `{available_modes}` with live data.
   *
   * @param name - The unique skill name
   * @returns The Markdown body of the skill's SKILL.md
   * @throws Error if the skill is not registered or SKILL.md is missing
   */
  loadSkillContent(name: string): string {
    const meta = this.skills.get(name);
    if (!meta) {
      throw new Error(`Skill not found: ${name}`);
    }
    let body = this.readBuiltinBody(name);
    if (body === null) {
      throw new Error(`SKILL.md missing for skill: ${name}`);
    }

    // Dynamic model injection for AIGC plan skills
    if (name in DYNAMIC_SKILLS && body.includes("{available_models}")) {
      try {
        const builder = DYNAMIC_SKILLS[name]!;
        body = body.replace("{available_models}", builder());
      } catch {
        body = body.replace(
          "{available_models}",
          "_Model list unavailable. Check provider configuration._",
        );
      }
    }

    // Dynamic mode injection for AIGC plan skills
    if (name in DYNAMIC_MODES && body.includes("{available_modes}")) {
      try {
        const [modality, allowed] = DYNAMIC_MODES[name]!;
        body = body.replace("{available_modes}", buildModesSection(modality, allowed));
      } catch {
        body = body.replace(
          "{available_modes}",
          "_Mode definitions unavailable. Check provider configuration._",
        );
      }
    }

    return body;
  }

  /**
   * Load a support file (references/, scripts/, assets/) for a skill.
   *
   * @param name - The unique skill name
   * @param relativePath - Path relative to the skill root (e.g. "references/spec.md")
   * @returns The file content as a string
   * @throws Error if the skill is not registered or the file is missing
   */
  loadSkillFile(name: string, relativePath: string): string {
    const meta = this.skills.get(name);
    if (!meta) {
      throw new Error(`Skill not found: ${name}`);
    }
    const fullPath = join(this.skillsDir, name, relativePath);
    if (!existsSync(fullPath)) {
      throw new Error(`${name}/${relativePath} not found`);
    }
    return readFileSync(fullPath, "utf-8");
  }

  // ── Internal helpers ────────────────────────────────────────────

  /**
   * Scan the built-in skills directory and register each valid skill.
   *
   * Reads `name` and `description` from SKILL.md frontmatter.
   * Runtime config (tools, category, output_type, requires, etc.)
   * comes from `metadata.json` with fallback to frontmatter fields.
   */
  private loadBuiltin(): void {
    if (!existsSync(this.skillsDir)) return;

    for (const entry of readdirSync(this.skillsDir)) {
      const skillDir = join(this.skillsDir, entry);
      if (!statSync(skillDir).isDirectory()) continue;

      const skillMdPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      const raw = readFileSync(skillMdPath, "utf-8");
      const frontmatter = parseFrontmatter(raw);
      if (!frontmatter.name) continue;

      // Load metadata.json for runtime config (preferred source)
      let pkg = loadMetadata(skillDir);
      let requires: Record<string, string[]> = pkg.requires as Record<string, string[]> ?? {};

      // Fallback: legacy frontmatter fields for backward compatibility
      if (Object.keys(pkg).length === 0 && frontmatter.tools) {
        pkg = frontmatter;
        const breatic = (frontmatter.metadata as Record<string, unknown>)?.breatic as Record<string, unknown> ?? {};
        requires = breatic.requires as Record<string, string[]> ?? {};
      }

      const meta: InternalSkillMeta = {
        name: frontmatter.name as string,
        description: (frontmatter.description as string) ?? "",
        scope: (pkg.scope as string[]) ?? ["agent"],
        always: (pkg.always as boolean) ?? false,
        disableModelInvocation: (pkg.disable_model_invocation as boolean) ?? false,
        userInvocable: (pkg.user_invocable as boolean) ?? true,
        requiresBins: (requires.bins as string[]) ?? [],
        requiresEnv: (requires.env as string[]) ?? [],
        tools: (pkg.tools as string[]) ?? [],
        outputType: (pkg.output_type as string) ?? "canvas",
        category: (pkg.category as string) ?? "default",
        keywords: (pkg.keywords as string[]) ?? [],
      };
      this.skills.set(meta.name, meta);
    }
  }

  /**
   * Read and return the Markdown body of a built-in skill's SKILL.md.
   *
   * @param name - The built-in skill name (also its directory name)
   * @returns The Markdown body with frontmatter stripped, or null if missing
   */
  private readBuiltinBody(name: string): string | null {
    const p = join(this.skillsDir, name, "SKILL.md");
    if (!existsSync(p)) return null;
    return stripFrontmatter(readFileSync(p, "utf-8"));
  }
}

// ── Standalone helpers ──────────────────────────────────────────────

/**
 * Load and parse metadata.json from a skill directory.
 *
 * @param skillDir - Path to the skill directory
 * @returns Parsed JSON object, or empty object if missing/invalid
 */
function loadMetadata(skillDir: string): Record<string, unknown> {
  const pkgPath = join(skillDir, "metadata.json");
  if (!existsSync(pkgPath)) return {};
  try {
    return JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 *
 * @param text - Full file content potentially starting with `---` delimiters
 * @returns Parsed frontmatter fields, or empty object if none found
 */
function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  return (parseYaml(text.slice(3, end)) as Record<string, unknown>) ?? {};
}

/**
 * Remove YAML frontmatter delimited by `---` from text.
 *
 * @param text - Full file content potentially starting with frontmatter
 * @returns Text with frontmatter removed, leading newlines stripped
 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\n+/, "");
}

/**
 * Check whether a skill's runtime dependencies are satisfied.
 *
 * Uses `which` to check for binaries on PATH (safe: no shell expansion).
 *
 * @param skill - The internal skill metadata
 * @returns True if all required binaries and env vars are present
 */
function checkAvailability(skill: InternalSkillMeta): boolean {
  for (const bin of skill.requiresBins) {
    try {
      execFileSync("which", [bin], { stdio: "ignore" });
    } catch {
      return false;
    }
  }
  for (const envVar of skill.requiresEnv) {
    // Skill-declared required env vars are dynamic (not part of the
    // typed config schema), so read them from the injected raw env
    // via getRawEnvVar rather than process.env directly.
    if (!getRawEnvVar(envVar)) return false;
  }
  return true;
}

// ── Model list formatting ───────────────────────────────────────────

/** Model info as returned by provider `listAvailable*Models()`. */
interface ModelInfo {
  name: string;
  mode: string | string[];
  guide?: string;
  description?: string;
  languages?: string[];
  params?: Record<string, ParamInfo>;
  voices?: Array<{ id: string; gender?: string; description?: string }>;
}

interface ParamInfo {
  type?: string;
  values?: unknown[];
  default?: unknown;
  description?: string;
}

/**
 * Format a list of model info dicts into a Markdown section with param tables.
 *
 * @param models - Model dicts from `listAvailableModels()`
 * @param modeLabels - Mapping of mode codes to display labels
 * @param emptyMsg - Fallback message when no models are available
 * @returns A Markdown string ready to inject into a SKILL.md template
 */
function formatModelsSection(
  models: ModelInfo[],
  modeLabels: Record<string, string>,
  emptyMsg: string,
): string {
  if (models.length === 0) return emptyMsg;

  const sections: string[] = [];
  for (const m of models) {
    const modeLabel = Array.isArray(m.mode)
      ? m.mode.map((code) => modeLabels[code] ?? code).join(" / ")
      : modeLabels[m.mode] ?? m.mode;

    let header = m.guide
      ? `### \`${m.name}\` (${modeLabel})\n\n${m.guide}`
      : `### \`${m.name}\` (${modeLabel})`;

    if (m.languages && m.languages.length > 0) {
      header += `\n\n**Languages:** ${m.languages.join(", ")}`;
    }

    const params = m.params ?? {};
    const paramKeys = Object.keys(params);
    let table: string;

    if (paramKeys.length > 0) {
      const rows = [
        "| Parameter | Type | Values | Default | Description |",
        "|-----------|------|--------|---------|-------------|",
      ];
      for (const pname of paramKeys) {
        const spec = params[pname]!;
        const ptype = spec.type ?? "string";
        let valStr = "\u2014";
        if (spec.values != null) {
          const strs = spec.values.map(String);
          valStr = strs.slice(0, 6).join(", ") + (strs.length > 6 ? ", ..." : "");
        }
        const defaultStr = spec.default != null ? String(spec.default) : "\u2014";
        const desc = spec.description ?? "";
        rows.push(`| \`${pname}\` | ${ptype} | ${valStr} | ${defaultStr} | ${desc} |`);
      }
      table = rows.join("\n");
    } else {
      table = "_No configurable parameters._";
    }

    sections.push(`${header}\n\n${table}`);
  }

  return sections.join("\n\n---\n\n");
}

// ── Mode configuration ──────────────────────────────────────────────

let _modesConfigCache: Record<string, unknown> | null = null;

/**
 * Load mode definitions from `config/models/modes.yaml`.
 *
 * @returns Parsed YAML keyed by modality
 */
function loadModesConfig(): Record<string, unknown> {
  if (_modesConfigCache) return _modesConfigCache;
  if (!existsSync(MODES_CONFIG_PATH)) return {};
  _modesConfigCache = parseYaml(readFileSync(MODES_CONFIG_PATH, "utf-8")) as Record<
    string,
    unknown
  >;
  return _modesConfigCache;
}

/**
 * Extract mode code to display label mapping for a modality.
 *
 * @param modality - One of "image", "video", "audio", "tts", "three_d", "understand"
 * @returns Mapping of mode codes to labels
 */
function getModeLabels(modality: string): Record<string, string> {
  const cfg = (loadModesConfig()[modality] ?? {}) as Record<string, unknown>;
  const modes = (cfg.modes ?? {}) as Record<string, Record<string, string>>;
  const labels: Record<string, string> = {};
  for (const [code, m] of Object.entries(modes)) {
    labels[code] = m.label ?? code;
  }
  return labels;
}

/**
 * Build a Markdown Mode Selection section from `modes.yaml`.
 *
 * @param modality - One of "image", "video", "audio", "tts", "three_d", "understand"
 * @param allowedModes - If provided, only include these mode codes. Null means all.
 * @returns A Markdown string with mode descriptions and selection guide
 */
function buildModesSection(
  modality: string,
  allowedModes: ReadonlySet<string> | null,
): string {
  const cfg = (loadModesConfig()[modality] ?? {}) as Record<string, unknown>;
  const modes = (cfg.modes ?? {}) as Record<string, Record<string, string>>;
  if (Object.keys(modes).length === 0) return "";

  const lines: string[] = [];
  for (const [code, m] of Object.entries(modes)) {
    if (allowedModes && !allowedModes.has(code)) continue;
    const desc = (m.description ?? "").trim();
    lines.push(`- **${code}** (${m.label}): ${desc}`);
  }

  const guide = ((cfg.selection_guide as string) ?? "").trim();
  if (guide) {
    lines.push("");
    lines.push("Choose the mode based on intent:");
    lines.push(guide);
  }

  return lines.join("\n");
}

/**
 * Filter model list to only include models whose mode is in allowedModes.
 *
 * Handles both single-mode strings and multi-mode arrays.
 *
 * @param models - Model dicts from `listAvailableModels()`
 * @param allowedModes - Set of mode codes to keep
 * @returns Filtered list of model dicts
 */
function filterModelsByModes(
  models: ModelInfo[],
  allowedModes: ReadonlySet<string>,
): ModelInfo[] {
  return models.filter((m) => {
    if (Array.isArray(m.mode)) {
      return m.mode.some((code) => allowedModes.has(code));
    }
    return allowedModes.has(m.mode);
  });
}

// ── Model list access ────────────────────────────────────────────────

import { listAvailableModels } from "@core/config/model-catalog.js";

function getModelsForModality(modality: string): ModelInfo[] {
  return listAvailableModels(modality) as ModelInfo[];
}

// ── Dynamic skill builders ──────────────────────────────────────────

const IMAGE_PLAN_MODES: ReadonlySet<string> = new Set(["t2i", "i2i"]);
const VIDEO_PLAN_MODES: ReadonlySet<string> = new Set(["t2v", "i2v", "ref"]);

function buildImageModelsSection(): string {
  const models = filterModelsByModes(getModelsForModality("image"), IMAGE_PLAN_MODES);
  return formatModelsSection(
    models,
    getModeLabels("image"),
    "_No image models available. Check your API key configuration._",
  );
}

function buildAudioModelsSection(): string {
  return formatModelsSection(
    getModelsForModality("audio"),
    getModeLabels("audio"),
    "_No audio models available. Check your API key configuration._",
  );
}

function buildVideoModelsSection(): string {
  const models = filterModelsByModes(getModelsForModality("video"), VIDEO_PLAN_MODES);
  return formatModelsSection(
    models,
    getModeLabels("video"),
    "_No video models available. Check your API key configuration._",
  );
}

function buildTtsModelsSection(): string {
  const models = getModelsForModality("tts");
  let base = formatModelsSection(
    models,
    getModeLabels("tts"),
    "_No TTS models available. Check your API key configuration._",
  );

  const voicesSections: string[] = [];
  for (const m of models) {
    const voices = m.voices ?? [];
    if (voices.length === 0) continue;
    const rows = [
      `\n\n**Voices for \`${m.name}\`:**\n`,
      "| Voice ID | Gender | Description |",
      "|----------|--------|-------------|",
    ];
    for (const v of voices) {
      rows.push(`| \`${v.id}\` | ${v.gender ?? "\u2014"} | ${v.description ?? ""} |`);
    }
    voicesSections.push(rows.join("\n"));
  }

  if (voicesSections.length > 0) {
    base += "\n" + voicesSections.join("\n");
  }
  return base;
}

function buildThreeDModelsSection(): string {
  return formatModelsSection(
    getModelsForModality("three_d"),
    getModeLabels("three_d"),
    "_No 3D models available. Check your API key configuration._",
  );
}

function buildUnderstandModelsSection(): string {
  return formatModelsSection(
    getModelsForModality("understand"),
    getModeLabels("understand"),
    "_No understand models available. Check your API key configuration._",
  );
}

/** Skill name to builder function for dynamic `{available_models}` injection. */
const DYNAMIC_SKILLS: Record<string, () => string> = {
  generate_image_plan: buildImageModelsSection,
  generate_audio_plan: buildAudioModelsSection,
  generate_video_plan: buildVideoModelsSection,
  generate_tts_plan: buildTtsModelsSection,
  generate_3d_plan: buildThreeDModelsSection,
  vision_analyze: buildUnderstandModelsSection,
};

/**
 * Skill name to (modality, allowedModes) for dynamic `{available_modes}` injection.
 * A null allowedModes means all modes for that modality are included.
 */
const DYNAMIC_MODES: Record<string, [string, ReadonlySet<string> | null]> = {
  generate_image_plan: ["image", IMAGE_PLAN_MODES],
  generate_audio_plan: ["audio", null],
  generate_video_plan: ["video", VIDEO_PLAN_MODES],
  generate_tts_plan: ["tts", null],
  generate_3d_plan: ["three_d", null],
  vision_analyze: ["understand", null],
};

// ── Singleton ───────────────────────────────────────────────────────

let _singleton: SkillRegistry | null = null;

/**
 * Return the singleton SkillRegistry instance, creating it on first call.
 *
 * @returns The application-wide SkillRegistry
 */
export function getSkillRegistry(): SkillRegistry {
  if (!_singleton) {
    _singleton = new SkillRegistry();
  }
  return _singleton;
}
