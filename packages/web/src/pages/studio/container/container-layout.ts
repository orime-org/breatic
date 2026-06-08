// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The studio container's centered content column (neutral mock §container).
 * Every band inside the container — the studio header, the tab strip (whose
 * bottom border therefore spans this width, not the viewport), the tab content
 * and the non-member view — shares this max-width + auto margins + 28px gutters
 * so they line up in one 1100px column. Single source of the column width:
 * change it here and every band moves together.
 */
export const CENTER_COLUMN = 'mx-auto w-full max-w-[1100px] px-7';
