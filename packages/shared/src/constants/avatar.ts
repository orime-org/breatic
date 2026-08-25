// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The edge length of a stored studio avatar, in pixels.
 *
 * This lives in shared because it is a CONTRACT between two packages that must
 * agree exactly: the browser crops every avatar to this square before upload,
 * and the server refuses any upload that is not it. Two copies of the number
 * would eventually disagree, and the failure would be every avatar upload
 * being rejected — with the two sides each convinced they were right.
 *
 * It is a constant rather than a yaml knob because changing it is never just
 * this number: `avatar.max_bytes` in `config/storage.yaml` is sized against
 * the worst-case PNG at THIS resolution (~880 KB at 512²; roughly 3.5 MB at
 * 1024²), so moving one without the other starts refusing real avatars.
 */
export const AVATAR_OUTPUT_PX = 512;
