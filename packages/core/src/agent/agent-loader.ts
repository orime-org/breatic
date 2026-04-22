/**
 * Agent definition loader — parses agents/*.md frontmatter.
 *
 * Each agent file is a Markdown document with YAML frontmatter defining
 * the agent's role, tools, model, and default skills. The body is the
 * system prompt.
 *
 * @module
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, extname } from "node:path";
import { logger } from "../logger.js";
import { MONOREPO_ROOT } from "../config/env.js";

/** Root directory for agent definitions. */
const AGENTS_DIR = resolve(MONOREPO_ROOT, "agents");

/** Parsed agent definition. */
export interface AgentDefinition {
  /** Unique agent name (filename without extension). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Tools this agent has access to. */
  tools: readonly string[];
  /** LLM model identifier. */
  model: string;
  /** Default skill names to load. */
  skills: readonly string[];
  /** System prompt (markdown body after frontmatter). */
  systemPrompt: string;
}

/**
 * Parse YAML frontmatter from a markdown string.
 *
 * @returns Tuple of [frontmatter object, body string]
 */
function parseFrontmatter(content: string): [Record<string, unknown>, string] {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return [{}, content];

  const frontmatter: Record<string, unknown> = {};
  const yamlLines = match[1]!.split("\n");

  for (const line of yamlLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Parse arrays: ["a", "b"] or [a, b]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      value = inner.length === 0
        ? []
        : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    }

    frontmatter[key] = value;
  }

  return [frontmatter, match[2]!.trim()];
}

let _cache: ReadonlyMap<string, AgentDefinition> | null = null;

/**
 * Load all agent definitions from the agents/ directory.
 *
 * Results are cached after first load.
 *
 * @returns Map of agent name to AgentDefinition
 */
export function loadAgents(): ReadonlyMap<string, AgentDefinition> {
  if (_cache) return _cache;

  const agents = new Map<string, AgentDefinition>();

  let files: string[];
  try {
    files = readdirSync(AGENTS_DIR).filter((f) => extname(f) === ".md");
  } catch {
    logger.warn({ dir: AGENTS_DIR }, "Agents directory not found");
    _cache = agents;
    return agents;
  }

  for (const file of files) {
    try {
      const content = readFileSync(resolve(AGENTS_DIR, file), "utf-8");
      const [fm, body] = parseFrontmatter(content);

      const name = (fm.name as string) || file.replace(".md", "");
      const definition: AgentDefinition = {
        name,
        description: (fm.description as string) || "",
        tools: (fm.tools as string[]) || [],
        model: (fm.model as string) || "anthropic/claude-sonnet-4-6",
        skills: (fm.skills as string[]) || [],
        systemPrompt: body,
      };

      agents.set(name, definition);
    } catch (err) {
      logger.warn({ file, err }, "Failed to parse agent definition");
    }
  }

  logger.info({ count: agents.size, agents: [...agents.keys()] }, "Loaded agent definitions");
  _cache = agents;
  return agents;
}

/**
 * Get a single agent definition by name.
 *
 * @param name - Agent name (e.g. "researcher")
 * @returns AgentDefinition or undefined if not found
 */
export function getAgent(name: string): AgentDefinition | undefined {
  return loadAgents().get(name);
}

/**
 * List all available agent names and descriptions.
 *
 * Used by MainAgent's system prompt to describe available sub-agents.
 */
export function listAgents(): ReadonlyArray<{ name: string; description: string }> {
  return [...loadAgents().values()].map(({ name, description }) => ({ name, description }));
}

/** Reset cached agents (for testing). */
export function resetAgentCache(): void {
  _cache = null;
}
