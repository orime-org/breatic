// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

// RuleTester carries its own test-framework bindings as static properties and
// throws on construction when they are unset. Wiring them once here rather
// than at the top of every rule's test file: a file that forgot the wiring
// failed to collect at all, which reads in the summary as a file error while
// the test count still shows every other file passing.
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
