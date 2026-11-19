// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Markdown and the document body's blocks (breatic#1488 §11.2): an agent
 * reads and writes Markdown, collab reads and writes BlockNote block JSON.
 * The conversion runs on a headless editor of the body's own schema, and
 * BlockNote's Markdown conversion needs a DOM, so this module installs
 * jsdom's before its first use; collab's side needs none.
 */

import { BODY_HEADING_LEVELS, documentBlockEditor } from "@breatic/shared/document-model";
import { JSDOM } from "jsdom";

/** One block as BlockNote JSON. */
export interface DocumentBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: DocumentBlock[];
  [key: string]: unknown;
}

/** The DOM globals BlockNote's Markdown conversion reaches for. */
const DOM_GLOBALS = ["window", "document", "DOMParser", "Node", "HTMLElement", "Element"] as const;
let domInstalled = false;

/** Give the process jsdom's DOM, once; globals Node already has are left alone. */
function installDom(): void {
  if (domInstalled) return;
  const { window } = new JSDOM("<!doctype html><html><body></body></html>");
  const global = globalThis as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) global[key] ??= (window as unknown as Record<string, unknown>)[key];
  domInstalled = true;
}

/** The deepest heading the body carries. */
const DEEPEST_HEADING = Math.max(...BODY_HEADING_LEVELS);

/**
 * Bring every heading within the levels the body carries, children included.
 * @param blocks - The blocks.
 * @returns The same blocks, headings clamped.
 */
function clampHeadings(blocks: DocumentBlock[]): DocumentBlock[] {
  return blocks.map((block) => ({
    ...block,
    ...(block.type === "heading" && typeof block.props?.level === "number" && block.props.level > DEEPEST_HEADING
      ? { props: { ...block.props, level: DEEPEST_HEADING } }
      : {}),
    ...(block.children ? { children: clampHeadings(block.children) } : {}),
  }));
}

/**
 * Parse Markdown into the body's blocks.
 * @param markdown - The Markdown.
 * @returns The blocks, as BlockNote JSON.
 */
export async function markdownToBlocks(markdown: string): Promise<DocumentBlock[]> {
  installDom();
  const blocks = (await documentBlockEditor().tryParseMarkdownToBlocks(markdown)) as unknown as DocumentBlock[];
  return clampHeadings(blocks);
}

/**
 * Write one block, children included, as Markdown.
 * @param block - The block.
 * @returns Its Markdown.
 */
export async function blockToMarkdown(block: DocumentBlock): Promise<string> {
  installDom();
  return await documentBlockEditor().blocksToMarkdownLossy([block] as never);
}

/** Block props whose non-default value Markdown cannot carry, and what to call them. */
const LOST_PROPS: ReadonlyArray<[string, string, unknown]> = [
  ["textColor", "text color", "default"],
  ["backgroundColor", "background color", "default"],
  ["textAlignment", "alignment", "left"],
];

/** Inline styles Markdown cannot carry. */
const LOST_STYLES: Readonly<Record<string, string>> = { underline: "underline", textColor: "text color", backgroundColor: "background color" };

/**
 * Collect the inline styles a block's runs use, children included.
 * @param block - The block.
 * @param into - Where the style names go.
 */
function stylesIn(block: DocumentBlock, into: Set<string>): void {
  if (Array.isArray(block.content)) {
    for (const run of block.content as Array<{ styles?: Record<string, unknown> }>) {
      for (const [style, value] of Object.entries(run.styles ?? {})) if (value !== undefined && value !== false) into.add(style);
    }
  }
  for (const child of block.children ?? []) stylesIn(child, into);
}

/**
 * What a block carries that its Markdown loses, so an agent leaves it alone
 * or edits it with `edit_document_text`, which keeps it.
 * @param block - The block.
 * @param hasComments - Whether a comment thread is on its words.
 * @returns The names of what is lost.
 */
export function notInMarkdown(block: DocumentBlock, hasComments: boolean): string[] {
  const lost = new Set<string>();
  for (const [prop, name, plain] of LOST_PROPS) {
    const value = block.props?.[prop];
    if (value !== undefined && value !== plain) lost.add(name);
  }
  const styles = new Set<string>();
  stylesIn(block, styles);
  for (const style of styles) {
    const name = LOST_STYLES[style];
    if (name) lost.add(name);
  }
  if (hasComments) lost.add("comments");
  return [...lost];
}

/** The document's media block types. */
const MEDIA_TYPES: ReadonlySet<string> = new Set(["image", "video", "audio"]);

/** Where a medium lands: its stored address and size, or null to leave it out. */
export type MediaDecision = (url: string) => Promise<{ url: string; width: number; height: number } | null>;

/**
 * Settle every medium of parsed blocks: kept at the address the decision
 * gives, with its size, or left out.
 * @param blocks - The blocks.
 * @param decide - Where each medium lands.
 * @returns The blocks that land and how many media were left out.
 */
export async function settleMedia(blocks: DocumentBlock[], decide: MediaDecision): Promise<{ blocks: DocumentBlock[]; leftOut: number }> {
  let leftOut = 0;
  /**
   * Settle a list of blocks, children first.
   * @param list - The blocks.
   * @returns Those that land.
   */
  const settle = async (list: DocumentBlock[]): Promise<DocumentBlock[]> => {
    const landed: DocumentBlock[] = [];
    for (const block of list) {
      const children = block.children ? await settle(block.children) : undefined;
      const next = children ? { ...block, children } : block;
      const url = block.props?.url;
      if (!MEDIA_TYPES.has(block.type) || typeof url !== "string" || url === "") {
        landed.push(next);
        continue;
      }
      const stored = await decide(url);
      if (stored === null) {
        leftOut += 1;
        continue;
      }
      landed.push({
        ...next,
        props: { ...next.props, url: stored.url, ...(stored.width > 0 && stored.height > 0 ? { mediaWidth: stored.width, mediaHeight: stored.height } : {}) },
      });
    }
    return landed;
  };
  return { blocks: await settle(blocks), leftOut };
}
