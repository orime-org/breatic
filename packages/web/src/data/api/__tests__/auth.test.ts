// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { deriveDisplayName } from '@web/data/api/auth';

describe('deriveDisplayName', () => {
  // Canonical happy path — the user has completed onboarding, so their
  // personal studio carries a display name we render verbatim.
  it('prefers the personal-studio name when present', () => {
    expect(
      deriveDisplayName({
        personalStudioName: 'justin',
        email: 'songxiuxing@gmail.com',
      }),
    ).toBe('justin');
  });

  // The two-step registration gap: between step one (account created)
  // and step two (slug picked → personal studio created), the user has
  // `personalStudio === null`, so the name falls back to the email
  // local-part. Without this fallback the bell sheet falls back to the
  // raw user UUID.
  it('falls back to email local-part when personal-studio name is null', () => {
    expect(
      deriveDisplayName({ personalStudioName: null, email: 'foo@bar.com' }),
    ).toBe('foo');
  });

  // Defense against whitespace-only studio names (someone bypassing
  // client-side trim, or a legacy ' ' row). Treat as effectively empty
  // so the email fallback wins.
  it('treats a whitespace-only personal-studio name as empty and falls back', () => {
    expect(
      deriveDisplayName({
        personalStudioName: '   ',
        email: 'baz@example.com',
      }),
    ).toBe('baz');
  });

  // Pathological email without `@` (shouldn't happen — server
  // validates — but the helper must still return non-empty so
  // downstream callers can rely on it). `.split('@')[0]` returns the
  // whole string in that case, which is fine.
  it('returns the full email when the local-part split yields empty', () => {
    expect(
      deriveDisplayName({
        personalStudioName: null,
        email: '@only-domain.com',
      }),
    ).toBe('@only-domain.com');
  });
});
