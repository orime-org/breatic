// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  CAMERA_COMMAND_AXES,
  CAMERA_COMMANDS_PER_BRACKET,
  STATIC_SHOT,
} from '@breatic/shared';

/**
 * The picks a new command pushes out: everything for Static shot, and for a
 * movement Static shot plus the other direction of its axis. One bracket runs
 * its commands at the same time, so those would ask the camera for two
 * contradicting things at once.
 * @param picked - The commands picked so far, in pick order.
 * @param command - The command being added.
 * @returns The picks it replaces.
 */
function displacedBy(picked: readonly string[], command: string): string[] {
  if (command === STATIC_SHOT) return picked.filter((p) => p !== STATIC_SHOT);
  const directions: readonly string[] | undefined = CAMERA_COMMAND_AXES.find((axis) =>
    (axis.directions as readonly string[]).includes(command),
  )?.directions;
  const opposite = directions?.find((c) => c !== command);
  return picked.filter((p) => p === STATIC_SHOT || p === opposite);
}

/**
 * Whether a command can be clicked with these picks: a picked one can always be
 * taken out, and another one can go in while there is room after the picks it
 * replaces leave.
 * @param picked - The commands picked so far.
 * @param command - The command asked about.
 * @returns True when clicking it changes the picks.
 */
export function canPickCameraCommand(picked: readonly string[], command: string): boolean {
  if (picked.includes(command)) return true;
  return picked.length - displacedBy(picked, command).length < CAMERA_COMMANDS_PER_BRACKET;
}

/**
 * The picks after one click on a command: a picked one is taken out; another
 * one replaces what it contradicts and goes to the end; with no room it changes
 * nothing.
 * @param picked - The commands picked so far, in pick order.
 * @param command - The command clicked.
 * @returns The new picks.
 */
export function pickCameraCommand(picked: readonly string[], command: string): string[] {
  if (picked.includes(command)) return picked.filter((p) => p !== command);
  if (!canPickCameraCommand(picked, command)) return [...picked];
  const displaced = displacedBy(picked, command);
  return [...picked.filter((p) => !displaced.includes(p)), command];
}
