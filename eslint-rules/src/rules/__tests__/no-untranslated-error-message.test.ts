// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noUntranslatedErrorMessage } from "../no-untranslated-error-message";

const ruleTester = new RuleTester();

ruleTester.run("no-untranslated-error-message", noUntranslatedErrorMessage, {
  valid: [
    // The shape every client-facing throw should have.
    { code: 'throw new NotFoundError(t("server.skill.not_found"));' },
    { code: 'throw new ConflictError(t("server.studio.already_member"));' },
    // AppError puts the status first, so the message is the second argument.
    { code: 'throw new AppError(402, t("server.error.insufficient_credits", { required, available }));' },
    // A message assembled elsewhere is out of one file's sight; the rule
    // reports what is plainly written here, not what it cannot see.
    { code: "throw new ValidationError(buildMessage(field));" },
    { code: "throw new NotFoundError(reasonFromCaller);" },
    // ConflictLockedError builds its own message from a structured detail —
    // a caller has no message argument to get wrong.
    { code: "throw new ConflictLockedError({ holdingBy, holdingByName, taskId, startedAt, estimatedSeconds });" },
    { code: "class NodeLocked extends AppError { constructor(d) { super(409, t('server.canvas.node_locked')); } }" },
    // Not our error family.
    { code: 'throw new Error("internal invariant broken");' },
    { code: 'throw new TypeError("expected a number");' },
  ],
  invalid: [
    {
      code: 'throw new NotFoundError("Skill not found");',
      errors: [{ messageId: "untranslatedMessage", line: 1 }],
    },
    {
      code: 'throw new ForbiddenError("Access denied");',
      errors: [{ messageId: "untranslatedMessage", line: 1 }],
    },
    // A template literal is a literal too, and interpolating an id makes it
    // worse: the user reads an internal identifier they cannot act on.
    {
      code: "throw new NotFoundError(`Attachment not found: ${id}`);",
      errors: [{ messageId: "untranslatedMessage", line: 1 }],
    },
    // AppError's second argument, not its first.
    {
      code: 'throw new AppError(503, "Task event stream unavailable; please retry");',
      errors: [{ messageId: "untranslatedMessage", line: 1 }],
    },
    // Concatenation is the same literal with extra steps.
    {
      code: 'throw new ValidationError("Skill " + name + " not found");',
      errors: [{ messageId: "untranslatedMessage", line: 1 }],
    },
    // A subclass hardcoding its own message. `ConflictLockedError` shipped
    // exactly this way — its caller passes only a structured detail, so
    // watching callers alone said nothing about the sentence on the wire.
    {
      code: "class NodeLocked extends AppError { constructor(d) { super(409, 'Node is locked'); } }",
      errors: [{ messageId: "untranslatedMessage", line: 1 }],
    },
  ],
});
