// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The bracketed camera commands MiniMax documents for its video models
 * (platform.minimax.io/docs/api-reference/video-generation-t2v). A model reads
 * them out of the prompt: several inside one bracket run at the same time,
 * separate brackets run in the order they appear.
 *
 * The catalog loader refuses a declared command outside this list, and the
 * panel groups the picker by it.
 */

/** Every command, in the order the picker lays them out. */
export const CAMERA_COMMANDS = [
  "Truck left",
  "Truck right",
  "Pan left",
  "Pan right",
  "Push in",
  "Pull out",
  "Pedestal up",
  "Pedestal down",
  "Tilt up",
  "Tilt down",
  "Zoom in",
  "Zoom out",
  "Shake",
  "Tracking shot",
  "Static shot",
] as const;

/** One documented command. */
export type CameraCommand = (typeof CAMERA_COMMANDS)[number];

/** One camera axis: the name its row goes by, and its two directions. */
export interface CameraCommandAxis {
  /** Names the axis wherever it is shown, e.g. the picker's row label. */
  key: string;
  /** The two directions, which one bracket must not hold together. */
  directions: readonly [CameraCommand, CameraCommand];
}

/**
 * The six camera axes. One bracket runs its commands at the same time, so
 * both directions of an axis in one bracket ask the camera to move two
 * opposite ways at once.
 */
export const CAMERA_COMMAND_AXES: readonly CameraCommandAxis[] = [
  { key: "truck", directions: ["Truck left", "Truck right"] },
  { key: "pan", directions: ["Pan left", "Pan right"] },
  { key: "dolly", directions: ["Push in", "Pull out"] },
  { key: "pedestal", directions: ["Pedestal up", "Pedestal down"] },
  { key: "tilt", directions: ["Tilt up", "Tilt down"] },
  { key: "zoom", directions: ["Zoom in", "Zoom out"] },
];

/** The command that holds the camera still, which every movement contradicts. */
export const STATIC_SHOT: CameraCommand = "Static shot";

/** How many commands MiniMax recommends in one bracket. */
export const CAMERA_COMMANDS_PER_BRACKET = 3;

/**
 * Whether a string is one of the documented commands.
 * @param name - The string to check.
 * @returns True when it is.
 */
export function isCameraCommand(name: string): name is CameraCommand {
  return (CAMERA_COMMANDS as readonly string[]).includes(name);
}
