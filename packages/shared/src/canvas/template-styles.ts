// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Template styles (inner#1817, CAP-10): one template workflow, several named
 * styles. A template names the set it picks from (`GenerationTemplate.styles`);
 * a generate node names the part of the picked style its prompt takes
 * (`TemplateGenerateNode.styleWords`), written after its own words.
 *
 * Every word lives in `locales/template-styles/<locale>.json` under
 * `canvas.template.styleSet.<set>.style.<style>.<part>` (and `.name`), with
 * category names under `canvas.template.styleSet.<set>.category.<category>`.
 * Those catalogs are kept out of the main ones so the web entry download
 * stays within its budget; they are merged in on demand.
 */

/** One style of a set. */
export interface TemplateStyle {
  id: string;
  /** One of the set's categories; given exactly when the set has categories. */
  category?: string;
}

/** A set of styles a template can pick from. */
export interface TemplateStyleSet {
  id: string;
  /** Group headings in the menu, in order; a set without them lists its styles in one run. */
  categories?: readonly string[];
  /** In menu order within a category. */
  styles: readonly TemplateStyle[];
  /**
   * The parts each style writes, the first being the one that introduces a
   * style (the agent lists its first sentence).
   */
  parts: readonly string[];
  /** Whether each style has a thumbnail at `/template-styles/<set>/<style>.webp`. */
  thumbnails: boolean;
}

/**
 * Builds the film styles in category order.
 * @param byCategory - The style ids of each category.
 * @returns The styles.
 */
function inCategories(byCategory: Readonly<Record<string, readonly string[]>>): TemplateStyle[] {
  return Object.entries(byCategory).flatMap(([category, ids]) => ids.map((id) => ({ id, category })));
}

const FILM_STYLE_CATEGORIES = {
  painting: [
    'impasto-oil',
    'gouache-landscape',
    'loose-watercolour',
    'social-realist-tempera',
    'epic-poster-gouache',
    'tudor-court-portrait',
    'chiaroscuro-oil',
    'american-scene-realism',
    'egg-tempera',
    'transparent-watercolour',
    'gongbi-silk',
    'frontier-western-oil',
    'blue-oil-portrait',
    'soft-pastel',
    'portrait-miniature',
    'illuminated-manuscript',
  ],
  drawing: [
    'gothic-charcoal',
    'graphite-magazine',
    'one-line-caricature',
    'ink-wash-cartoon',
    'crayon-drawing',
    'pen-wash-sketch',
    'travel-journal',
    'technical-line-art',
    'section-axonometric',
    'cyanotype-blueprint',
    'typewriter-art',
    'scrimshaw',
  ],
  print: [
    'art-deco-poster',
    'expressionist-woodcut',
    'letterpress-engraving',
    'public-works-silkscreen',
    'wartime-lithograph',
    'wood-type-poster',
    'circus-chromolithograph',
    'belle-epoque-lithograph',
    'satirical-etching',
    'three-ink-stencil-print',
    'pop-photo-silkscreen',
    'hand-block-print',
    'natural-history-copperplate',
    'art-nouveau-panel',
    'linen-postcard',
    'street-stencil',
  ],
  cartoon: [
    'rubber-hose',
    'modernist-cartoon',
    'superhero-comic-page',
    'fashion-illustration',
    'magazine-cover-illustration',
    'airbrush-80s',
    'pixel-16bit',
  ],
  photo: [
    'sepia-albumen',
    'studio-glamour-bw',
    'halftone-spread',
    'kinescope-tv',
    'hand-tinted-photo',
    'instant-film-album',
    'bw-colour-accent',
    'silent-film-bw',
    'daguerreotype',
    'neon-snow-night',
  ],
  craft: ['stained-glass', 'toy-theatre', 'rococo-silhouette', 'pop-up-book', 'roman-mosaic', 'cut-paper-titles', 'red-black-stage'],
} as const;

/** Famous film styles (inner#1817): adapted from lemo-opuscar at 8814b84c (MIT, see THIRD-PARTY.md). */
const FILM_STYLES: TemplateStyleSet = {
  id: 'film-styles',
  categories: Object.keys(FILM_STYLE_CATEGORIES),
  styles: inCategories(FILM_STYLE_CATEGORIES),
  parts: ['still', 'shot', 'sound'],
  thumbnails: true,
};

/** Every style set, by id. */
export const TEMPLATE_STYLE_SETS = [FILM_STYLES] as const;

/** A style set's id. */
export type TemplateStyleSetId = 'film-styles';

/**
 * A style set by id.
 * @param id - The set's id.
 * @returns The set.
 * @throws {Error} When no set has that id.
 */
export function templateStyleSet(id: string): TemplateStyleSet {
  const set = TEMPLATE_STYLE_SETS.find((one) => one.id === id);
  if (set === undefined) throw new Error(`no template style set ${id}`);
  return set;
}

/**
 * The style set a template picks from.
 * @param template - The template.
 * @param template.styles - The set it names.
 * @returns Its set, or undefined for a template without styles.
 */
export function templateStylesOf(template: { styles?: TemplateStyleSetId }): TemplateStyleSet | undefined {
  return template.styles === undefined ? undefined : templateStyleSet(template.styles);
}

/**
 * The absolute locale key of one part of one style.
 * @param set - The set's id.
 * @param style - The style's id.
 * @param part - The part, or `name`.
 * @returns The key.
 */
export function templateStyleKey(set: string, style: string, part: string): string {
  return `canvas.template.styleSet.${set}.style.${style}.${part}`;
}
