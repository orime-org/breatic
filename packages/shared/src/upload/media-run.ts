// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Time kept back at the end of a media container run, before the Worker's
 * deadline. The deadline is an instant the Worker named on its own clock and
 * the container compares it against another, and after the run the Worker
 * still reads the object back once before it answers.
 *
 * The ingest Worker and its container hold runs to it, and the storage config
 * checks that a run deadline leaves room for two tools once it is taken off.
 */
export const PREVIEW_MARGIN_MS = 5_000;
