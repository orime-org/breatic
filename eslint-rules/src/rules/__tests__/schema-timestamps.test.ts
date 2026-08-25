// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { schemaTimestamps } from "../schema-timestamps";

const ruleTester = new RuleTester();

ruleTester.run("schema-timestamps", schemaTimestamps, {
  valid: [
    {
      code: `export const users = pgTable("users", { id: uuid("id"), ...timestamps, deletedAt: timestamp("deleted_at") });`,
    },
    // An append-only table spells created_at out instead of taking the pair.
    {
      code: `export const nodeHistory = pgTable("node_history", { createdAt: timestamp("created_at"), deletedAt: timestamp("deleted_at") });`,
    },
    // Allowlisted: nothing ever soft-deletes a payment.
    {
      code: `export const payments = pgTable("payments", { ...timestamps });`,
    },
    {
      code: `export const uploadGrants = pgTable("upload_grants", { createdAt: timestamp("created_at") });`,
    },
    // Quoted keys are the same columns.
    {
      code: `export const t = pgTable("t", { "createdAt": x, "deletedAt": y });`,
    },
    // Not a table at all.
    { code: `export const helper = buildThing("x", {});` },
    { code: `const n = 1;` },
  ],
  invalid: [
    {
      code: `export const widgets = pgTable("widgets", { id: uuid("id") });`,
      errors: [
        { messageId: "missingCreatedAt", data: { table: "widgets" } },
        { messageId: "missingDeletedAt", data: { table: "widgets" } },
      ],
    },
    {
      code: `export const widgets = pgTable("widgets", { ...timestamps });`,
      errors: [{ messageId: "missingDeletedAt" }],
    },
    {
      code: `export const widgets = pgTable("widgets", { deletedAt: timestamp("deleted_at") });`,
      errors: [{ messageId: "missingCreatedAt" }],
    },
    // The allowlist covers deleted_at only — created_at has no exemption.
    {
      code: `export const payments = pgTable("payments", { id: uuid("id") });`,
      errors: [{ messageId: "missingCreatedAt" }],
    },
    // updatedAt is not created_at.
    {
      code: `export const widgets = pgTable("widgets", { updatedAt: x, deletedAt: y });`,
      errors: [{ messageId: "missingCreatedAt" }],
    },
    // A spread of something else does not stand in for the timestamps pair.
    {
      code: `export const widgets = pgTable("widgets", { ...auditColumns, deletedAt: y });`,
      errors: [{ messageId: "missingCreatedAt" }],
    },
    // Columns the rule cannot read must fail, not pass.
    {
      code: `export const widgets = pgTable("widgets", columnsFromElsewhere);`,
      errors: [{ messageId: "unreadableColumns" }],
    },
    {
      code: `export const widgets = pgTable("widgets", () => ({ createdAt: x, deletedAt: y }));`,
      errors: [{ messageId: "unreadableColumns" }],
    },
    // A column named in a comment after the table is not a column. This is
    // exactly what let upload_grants pass the guard this rule replaces.
    {
      code: `export const widgets = pgTable("widgets", { createdAt: x });\n// no deletedAt here — this is an internal queue\n`,
      errors: [{ messageId: "missingDeletedAt" }],
    },
    // Two tables in one file are judged separately, not as one range.
    {
      code: `export const a = pgTable("a", { createdAt: x });\nexport const b = pgTable("b", { createdAt: x, deletedAt: y });`,
      errors: [{ messageId: "missingDeletedAt", data: { table: "a" } }],
    },
  ],
});
