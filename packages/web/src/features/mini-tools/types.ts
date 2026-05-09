/**
 * Mini-tool framework types — shared between schemas, controls,
 * BottomToolbar, and NodeFloatMenu.
 *
 * Schema-driven: a tool defines its parameters declaratively; the
 * BottomToolbar renders the matching control automatically. Adding a
 * new tool means adding a `ToolSchema` row in {@link tool-schemas.ts};
 * no UI changes needed unless the tool needs a `category: 'special'`
 * custom widget (planned for inpaint in F4-categoryA).
 *
 * The schema mirrors the server-side `imageToolSchema` /
 * `videoToolSchema` / `audioToolSchema` discriminated unions
 * (`packages/server/src/routes/schemas.ts`) — adding a frontend tool
 * row without a backing server schema produces a 4xx on Apply.
 */

/**
 * Where a mini-tool runs.
 *
 * - **A (instant, frontend)**: <100 ms operations on the asset itself
 *   (crop / rotate / brightness adjust / CSS filters). Works in the
 *   browser via canvas / image manipulation. No backend round-trip,
 *   no credit cost. Implementation lands in F4-categoryA — F4-framework
 *   only declares the category so the framework UI knows to disable
 *   Apply with a stub message.
 *
 * - **B (async, backend)**: ≥1 s operations needing AIGC providers
 *   (background removal / upscale / sharpen / etc). Posts to
 *   `/api/v1/mini-tools/{image|video|audio}` → BullMQ → Worker →
 *   NodeStateUpdateEvent. Costs credits.
 *
 * - **special**: Tools whose parameter UI doesn't fit the
 *   slider/select/toggle vocabulary (planned: inpaint with brush
 *   canvas). Renders a custom widget instead of `GenericParamsUI`.
 *   Out of F4-framework scope.
 */
export type ToolCategory = 'A' | 'B' | 'special';

/**
 * A single parameter on a tool. The `ui` discriminator picks the
 * matching React control when {@link BottomToolbar} renders.
 */
export type ParamConfig =
  | {
      id: string;
      type: 'number';
      ui: 'slider';
      min: number;
      max: number;
      step?: number;
      default: number;
      label: string;
    }
  | {
      id: string;
      type: 'enum';
      ui: 'select';
      options: ReadonlyArray<string>;
      default: string;
      label: string;
    }
  | {
      id: string;
      type: 'boolean';
      ui: 'toggle';
      default: boolean;
      label: string;
    };

/**
 * One mini-tool entry. Render order in {@link NodeFloatMenu} is the
 * order tools appear in `tool-schemas.ts`.
 */
export interface ToolSchema {
  /**
   * Stable id matching the server-side `tool` literal in the
   * discriminated union (e.g. `"remove-bg"` matches
   * `imageToolSchema` row `tool: z.literal("remove-bg")`).
   */
  id: string;
  /** Modality this tool operates on — picks which `/mini-tools/*` endpoint to POST to. */
  modality: 'image' | 'video' | 'audio';
  category: ToolCategory;
  /** Display label on the float menu button. */
  menuLabel: string;
  /** Display label in the BottomToolbar header (left-most pill). */
  title: string;
  /** Parameters surfaced to the user. Empty array → BottomToolbar shows "No parameters". */
  params: ReadonlyArray<ParamConfig>;
}
