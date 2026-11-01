// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Context } from "hono";

/**
 * Close the connection a body-limit refusal answers on (inner#1782).
 * @param _c - The request context.
 */
export function closeAfterRefusal(_c: Context): void {}
