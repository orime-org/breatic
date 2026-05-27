import { describe, it, expect } from 'vitest';

import { deriveDisplayName } from '@/data/api/auth';

describe('deriveDisplayName', () => {
  // Canonical happy path — user has set a display name on their
  // profile, so we render it verbatim.
  it('prefers username when present', () => {
    expect(
      deriveDisplayName({ username: 'justin', email: 'songxiuxing@gmail.com' }),
    ).toBe('justin');
  });

  // The real-world case that motivated this helper: Google OAuth
  // accounts created before username collection landed, and Q11
  // pre-fix users where `users.username` was migrated NULL. Without
  // this fallback the bell sheet falls back to the raw user UUID.
  it('falls back to email local-part when username is null', () => {
    expect(
      deriveDisplayName({ username: null, email: 'foo@bar.com' }),
    ).toBe('foo');
  });

  // Defense against whitespace-only usernames (someone bypassing
  // client-side trim, or legacy ' ' rows). Treat as effectively
  // empty so the email fallback wins.
  it('treats whitespace-only username as empty and falls back', () => {
    expect(
      deriveDisplayName({ username: '   ', email: 'baz@example.com' }),
    ).toBe('baz');
  });

  // Pathological email without `@` (shouldn't happen — server
  // validates — but the helper must still return non-empty so
  // downstream callers can rely on it). `.split('@')[0]` returns
  // the whole string in that case, which is fine.
  it('returns full email when local-part split yields empty', () => {
    expect(
      deriveDisplayName({ username: null, email: '@only-domain.com' }),
    ).toBe('@only-domain.com');
  });
});
