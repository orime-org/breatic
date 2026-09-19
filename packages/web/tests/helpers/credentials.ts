// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The accounts a run signs in as.
 *
 * Setup signs both in once and saves the cookies, so no case has to. The one
 * exception is the case that asks what one account's browser storage does to
 * the other's: changing who is signed in is the thing under test there, and it
 * has to happen in the browser the first account already wrote from. That case
 * reads the pair from here, so there is one place that names these variables
 * and one sentence that says what to do when they are missing.
 */
import type { Account } from './project';

/** What a run needs from the environment, per account. */
const VARIABLES: Readonly<Record<Account, { email: string; password: string }>> = {
  A: { email: 'SMOKE_EMAIL', password: 'SMOKE_PASSWORD' },
  B: { email: 'SMOKE_EMAIL_B', password: 'SMOKE_PASSWORD_B' },
};

/** An account's sign-in pair. */
export interface Credentials {
  email: string;
  password: string;
}

/**
 * Reads one required variable, or says which one is missing.
 * @param name - The variable's name.
 * @returns Its value.
 * @throws {Error} When it is absent or empty.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. The smoke suite signs in as a real account; see the smoke section of README.md for how to fill the four SMOKE_* keys.`,
    );
  }
  return value;
}

/**
 * The address and password for one account.
 * @param account - Which account to read.
 * @returns Both values.
 * @throws {Error} When either variable is absent or empty.
 */
export function credentialsFor(account: Account): Credentials {
  return {
    email: required(VARIABLES[account].email),
    password: required(VARIABLES[account].password),
  };
}
