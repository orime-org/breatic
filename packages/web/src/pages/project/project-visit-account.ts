// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { useCurrentUserStore } from '@web/stores/current-user';
import type { ProjectVisitAccountSource } from '@web/pages/project/project-visit';

// One app-lifetime cursor avoids retaining every departed visit as a store listener.
// Logging out and back into A retires A's old handles; same-account refresh keeps them.
let generation = 0;
useCurrentUserStore.subscribe((current, previous) => {
  if (current.user?.id !== previous.user?.id) generation += 1;
});

/** Auth ownership remains available after ProtectedRoute unmounts the page. */
export const PROJECT_VISIT_ACCOUNT_SOURCE: ProjectVisitAccountSource = {
  /**
   * Read the current session account.
   * @returns The current account, or null after logout.
   * @throws {never} Never.
   */
  getAccountId: (): string | null => useCurrentUserStore.getState().user?.id ?? null,
  /**
   * Read the account generation, including identity changes while away.
   * @returns The current identity generation.
   * @throws {never} Never.
   */
  getGeneration: (): number => generation,
  /**
   * Observe identity while a visit or its transport remains active.
   * @param listener - Check the original account's ownership.
   * @returns The subscription cleanup.
   * @throws {never} Never.
   */
  subscribe: (listener: () => void): (() => void) => useCurrentUserStore.subscribe(listener),
};
