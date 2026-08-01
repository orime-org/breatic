// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 * the worst-case PNG at THIS resolution, and moving one without the other
 * starts refusing real avatars.
 *
 * That worst case is 1,049,473 bytes at 512² — measured by deflating the
 * scanlines of an RGBA frame whose pixels AND alpha are random, the point
 * where there is nothing left to compress. It scales with the pixel count, so
 * 1024² is four times the raw scanlines and lands near 4.2 MB. The ~900 KB
 * figure that is easier to reach for assumes an opaque alpha channel, and a
 * picture with soft edges does not have one.
 */
export const AVATAR_OUTPUT_PX = 512;
