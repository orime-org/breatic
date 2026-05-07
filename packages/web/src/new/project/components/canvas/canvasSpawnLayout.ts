/**
 * Layout constants for programmatic “spawn output to the right” flows
 * ({@link LocalGenNode} send, image/video tool commits).
 */

/**
 * Horizontal gap (px) after the source node shell to the spawned output’s left edge.
 *
 * @remarks Used together with `GENERATOR_NODE_WIDTH_PX` / spawn helpers in `generatorPaletteOutput.ts`.
 */
/** Also used as horizontal spacing between consecutive generator output nodes in the same row. */
export const CANVAS_SPAWNED_OUTPUT_GAP_PX = 96 as const;
