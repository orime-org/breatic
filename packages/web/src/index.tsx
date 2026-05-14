import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/index.css';
import '@/i18n';
import 'virtual:svg-icons-register';
import { RouterProvider } from 'react-router-dom';
import router from '@/app/routes';
import { ThemeProvider } from '@/app/shell/themeProvider';
import { GlobalLoading } from '@/app/shell/loading';
import * as Sentry from '@sentry/react';

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
      'NetworkError when attempting to fetch resource'
    ];
    const message = event.exception?.values?.[0]?.value || '';
    if (ignoredErrors.some(err => message.includes(err))) {
      return null;
    }
    return event;
  },
});

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <Sentry.ErrorBoundary fallback={<div>Page Error</div>}>
    <React.StrictMode>
      <ThemeProvider>
        <GlobalLoading />
        <RouterProvider router={router} />
      </ThemeProvider>
    </React.StrictMode>
  </Sentry.ErrorBoundary>
);