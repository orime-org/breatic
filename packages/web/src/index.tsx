// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from '@web/App';
// Self-host Inter (the --font-sans primary) so the UI no longer depends on the
// viewer having Inter installed locally. This module mirrors the
// `@fontsource/inter` per-subset @font-face declarations (weights 400–800,
// lazy per unicode-range) but adds vertical-metrics overrides that re-center
// glyphs in every line box (#1777) — see the module for the rationale.
import '@web/theme/inter-adjusted';
import '@web/index.css';
import { bootstrapLocale } from '@web/i18n/locale-bootstrap';

// i18n must initialize before any component renders useTranslation().
bootstrapLocale();

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  enabled: import.meta.env.PROD,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_APP_VERSION,
  tracesSampleRate: 0.2,
  sendDefaultPii: false,
  beforeSend(event) {
    const ignoredErrors = [
      'ResizeObserver loop limit exceeded',
      'Script error.',
      'NetworkError when attempting to fetch resource',
    ];
    const message = event.exception?.values?.[0]?.value || '';
    if (ignoredErrors.some((err) => message.includes(err))) {
      return null;
    }
    return event;
  },
});

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);
root.render(
  <Sentry.ErrorBoundary fallback={<div>Page Error</div>}>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </Sentry.ErrorBoundary>,
);
