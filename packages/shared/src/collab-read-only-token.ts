// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The token a collaboration connection presents to say it only reads
 * (inner#1552). Identity still comes from the session cookie; this only asks
 * collab to open the connection read-only and give it no seat, so the browser
 * can read a Space the user has not opened without taking an editing seat.
 */
export const READ_ONLY_COLLAB_TOKEN = "__read_only__";
