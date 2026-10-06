// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ErrorEvent } from '@sentry/react';
import { describe, expect, it } from 'vitest';

import { errorMonitoringInit } from '@web/lib/error-monitoring';

const DSN = 'https://publickey@sentry.test.example/1';
const SHA = '4ca3e774ad2bb6b8f9406579ddc4bb611e5037a0';

describe('errorMonitoringInit', () => {
  it('starts nothing when no DSN is configured', () => {
    expect(errorMonitoringInit({ dsn: '', mode: 'production', version: SHA })).toBeNull();
    expect(errorMonitoringInit({ dsn: undefined, mode: 'production', version: SHA })).toBeNull();
  });

  it('carries the DSN, the build commit and the environment', () => {
    expect(errorMonitoringInit({ dsn: DSN, mode: 'production', version: SHA })).toMatchObject({
      dsn: DSN,
      release: SHA,
      environment: 'production',
    });
  });

  it('leaves the release unset when the build carries no full commit', () => {
    expect(errorMonitoringInit({ dsn: DSN, mode: 'production', version: 'dev' })).toHaveProperty(
      'release',
      undefined,
    );
    expect(errorMonitoringInit({ dsn: DSN, mode: 'production', version: undefined })).toHaveProperty(
      'release',
      undefined,
    );
  });

  it('names a build mode outside the shared names development', () => {
    expect(errorMonitoringInit({ dsn: DSN, mode: 'staging', version: SHA })?.environment).toBe('staging');
    expect(errorMonitoringInit({ dsn: DSN, mode: 'test', version: SHA })?.environment).toBe('development');
  });

  it('turns no tracing on and collects no user details, cookies, bodies or query strings', () => {
    const options = errorMonitoringInit({ dsn: DSN, mode: 'production', version: SHA });
    expect(options).not.toHaveProperty('tracesSampleRate');
    expect(options?.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
    });
  });

  it('drops the browser noise that names no fault of ours', () => {
    const beforeSend = errorMonitoringInit({ dsn: DSN, mode: 'production', version: SHA })?.beforeSend;
    const event = (value: string): ErrorEvent => ({ type: undefined, exception: { values: [{ value }] } });
    expect(beforeSend?.(event('ResizeObserver loop limit exceeded'), {})).toBeNull();
    expect(beforeSend?.(event('Script error.'), {})).toBeNull();
    expect(beforeSend?.(event('NetworkError when attempting to fetch resource.'), {})).toBeNull();
    const ours = event('Cannot read properties of undefined');
    expect(beforeSend?.(ours, {})).toBe(ours);
  });
});
