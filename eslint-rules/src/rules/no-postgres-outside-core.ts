// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { createInfraClientRule } from "#rules/infra-client-rule";

/** Only `@breatic/core` may talk to postgres directly. */
export const noPostgresOutsideCore = createInfraClientRule({
  name: "no-postgres-outside-core",
  module: "postgres",
  replacement: "take the db handle from @breatic/core",
});
