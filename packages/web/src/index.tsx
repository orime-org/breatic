// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
import { followPage, startProductAnalytics } from '@web/data/analytics';
import { router } from '@web/app/routes';
import { removeRetiredStorageKeys } from '@web/lib/storage-keys';
import { guardStrayFileDrops } from '@web/lib/stray-file-drop';
import { captureReferralFromUrl } from '@web/lib/referral-carry';

removeRetiredStorageKeys();
// Before the router rewrites the address (inner#1868 §11).
captureReferralFromUrl(new URL(window.location.href));
guardStrayFileDrops(window);

const errorMonitoring = errorMonitoringInit({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  mode: import.meta.env.MODE,
  version: import.meta.env.VITE_APP_VERSION,
});
if (errorMonitoring !== null) Sentry.init(errorMonitoring);

// i18n must initialize before any component renders useTranslation(); error
// monitoring comes first so a catalog that fails to download is reported.
await bootstrapLocale();
startProductAnalytics();
followPage(router.state.location.pathname);
router.subscribe((state) => followPage(state.location.pathname));

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
