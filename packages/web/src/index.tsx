// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from '@web/App';
import { AppErrorBoundary } from '@web/app/AppErrorBoundary';
// Self-host Inter (the --font-sans primary) so the UI no longer depends on the
// viewer having Inter installed locally. Weights mirror tokens.css usage.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@web/index.css';
import { bootstrapLocale } from '@web/i18n/locale-bootstrap';
import { errorMonitoringInit } from '@web/lib/error-monitoring';
import { removeRetiredStorageKeys } from '@web/lib/storage-keys';

// i18n must initialize before any component renders useTranslation().
bootstrapLocale();
removeRetiredStorageKeys();

const errorMonitoring = errorMonitoringInit({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  mode: import.meta.env.MODE,
  version: import.meta.env.VITE_APP_VERSION,
});
if (errorMonitoring !== null) Sentry.init(errorMonitoring);

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);
root.render(
  <AppErrorBoundary>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </AppErrorBoundary>,
);
