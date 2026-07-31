// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { createInfraClientRule } from "#rules/infra-client-rule";

/** Only `@breatic/core` may construct Redis clients. */
export const noIoredisOutsideCore = createInfraClientRule({
  name: "no-ioredis-outside-core",
  module: "ioredis",
  replacement: "take a Redis client from @breatic/core",
});
