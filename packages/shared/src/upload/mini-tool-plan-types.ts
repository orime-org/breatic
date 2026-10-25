// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Finite JSON is validated at admission; the container consumes only owned data types. */
type PlanJsonValue = string | number | boolean | null | PlanJsonValue[] | { [key: string]: PlanJsonValue };

/** Detector identity and effective parameters frozen when its analysis is accepted. */
export interface MiniToolPlanDetectorProfile {
  id: string;
  version: string;
  weightsHash: string | null;
  params: Record<string, PlanJsonValue>;
}

/** Media recipes shared with a container that loads no validation libraries. */
export type MiniToolPlanRecipe =
  | { kind: "inspect_video"; inputId: string }
  | { kind: "frame"; inputId: string; frameIndex: number }
  | { kind: "segment"; inputId: string; range: { start: number; end: number }; audioEnd?: number }
  | { kind: "people"; inputId: string; anchor: { frameIndex: number; pts: number }; profile: MiniToolPlanDetectorProfile }
  | { kind: "scene_cuts"; inputId: string; range: { start: number; end: number }; profile: MiniToolPlanDetectorProfile };
