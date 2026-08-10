// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noRawBodyParse } from "../no-raw-body-parse";

const ruleTester = new RuleTester();

ruleTester.run("no-raw-body-parse", noRawBodyParse, {
  valid: [
    // The shape every route uses: the wrapper parses, the handler reads.
    { code: "app.post('/x', validate('json', s), (c) => c.req.valid('json'));" },
    // Raw bytes are a different need with a legitimate answer: a Stripe
    // webhook signature is computed over the bytes as sent, so parsing first
    // would destroy the thing being verified.
    { code: "const raw = await c.req.text();" },
    { code: "const buf = await c.req.arrayBuffer();" },
    // Reading the underlying stream, which `readBoundedBody` does. Note this
    // is `.raw.body`, a property — `c.req.raw.json()` is a body-parsing call
    // the rule also lets through, which is a gap in the matcher rather than a
    // decision. The rule's docstring lists it; widening is filed separately.
    { code: "const body = c.req.raw.body;" },
    // Reading validated output, not the request.
    { code: "const body = c.req.valid('json');" },
    // Unrelated `json` calls — a response, or somebody else's object.
    { code: "return c.json({ data });" },
    { code: "const parsed = await response.json();" },
  ],
  invalid: [
    // The shape task #60 shipped: parse the body by hand, hand it to a schema,
    // and a rejection leaves as a bare ZodError the exit answers 500 for.
    {
      code: "const body = schema.parse(await c.req.json());",
      errors: [{ messageId: "rawBodyParse", line: 1 }],
    },
    // Still the same call without the schema around it.
    {
      code: "const body = await c.req.json();",
      errors: [{ messageId: "rawBodyParse", line: 1 }],
    },
    // The context is not always named `c` — the rule reads the call, not the
    // variable, so a rename does not slip past it.
    {
      code: "const body = await ctx.req.json();",
      errors: [{ messageId: "rawBodyParse", line: 1 }],
    },
    // Form bodies are structured input too, and have the same schema to meet.
    {
      code: "const form = await c.req.parseBody();",
      errors: [{ messageId: "rawBodyParse", line: 1 }],
    },
    {
      code: "const form = await c.req.formData();",
      errors: [{ messageId: "rawBodyParse", line: 1 }],
    },
  ],
});
