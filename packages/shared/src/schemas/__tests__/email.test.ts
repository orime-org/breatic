// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { emailSchema, loginSchema, normalizeEmail, registerSchema } from "@shared/index.js";

describe("normalizeEmail", () => {
  it("lower-cases the whole address and drops surrounding space", () => {
    expect(normalizeEmail("  Foo.Bar@Example.COM \t")).toBe("foo.bar@example.com");
  });

  it("leaves an already normalized address unchanged", () => {
    expect(normalizeEmail("foo@example.com")).toBe("foo@example.com");
  });
});

describe("emailSchema", () => {
  it("returns the normalized address", () => {
    expect(emailSchema.parse("  Foo@X.com  ")).toBe("foo@x.com");
  });

  it("rejects what is not an email address after trimming", () => {
    expect(emailSchema.safeParse("  not-an-email ").success).toBe(false);
  });
});

describe("the auth schemas read the address through emailSchema", () => {
  it("registerSchema normalizes the address", () => {
    expect(registerSchema.parse({ email: " Foo@X.com", password: "password1" }).email).toBe("foo@x.com");
  });

  it("loginSchema normalizes the address", () => {
    expect(loginSchema.parse({ email: "FOO@X.COM ", password: "p" }).email).toBe("foo@x.com");
  });
});
