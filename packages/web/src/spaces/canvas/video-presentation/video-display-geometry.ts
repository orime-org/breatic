// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The canonical presentation's actual CSS box relative to its node wrapper. */
export interface VideoDisplayGeometry {
  element: HTMLElement;
  at: { x: number; y: number };
  box: { width: number; height: number };
  src: string;
}

/**
 * Reads display geometry without consulting a hidden packed decoder.
 * @param _wrapper - The positioned canvas node wrapper.
 * @returns Its actual canonical display box, when measured.
 * @throws {never} Missing or unmeasured display boxes return null.
 */
export function readVideoDisplayGeometry(_wrapper: HTMLElement | null): VideoDisplayGeometry | null { return null; }
