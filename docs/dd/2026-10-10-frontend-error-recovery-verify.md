# Frontend error recovery and translation interference

Date: 2026-10-10. User approved component isolation, localized route/application recovery and Sentry reporting, and selected native product language switching instead of external interface translation.

## Scope and cause

Google button render/effect exceptions must not unmount the email form. Route and application render failures must offer full-document reload and home navigation without exposing exception text. External translation can replace text nodes that React still owns; an ensuing DOM operation can fail. Translation opt-out is a request to browsers/extensions, not authority over extensions that ignore it. No promise is made that arbitrary extension mutations cannot fail.

Sources: [React issue 11538](https://github.com/facebook/react/issues/11538), [HTML translate inheritance](https://html.spec.whatwg.org/multipage/dom.html#attr-translate), [Google supported browsers](https://developers.google.com/identity/gsi/web/guides/supported-browsers), [React error boundaries](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary).

## Implementation choice

Reuse the installed Sentry ErrorBoundary for Google and the application. Keep RouterProvider.onError as the single route reporting point. Its provider-local report associates the original error object with its event ID; the route fallback displays it only when useRouteError matches that object. No location, form, credential or document content is attached. Full navigation reconstructs the document instead of trying to recover a mutated DOM by rerendering it.

The HTML document declares translate=no and notranslate before JavaScript starts. Body portals and editable document content inherit the protection. Product locale switching still uses the existing five catalogs. No DOM prototype interception, exception suppression, mutation repair observer or new dependency is introduced.

## Owned state and transitions

Sentry boundary state is owned by the installed SDK, not copied into application state. Existing Google script/credential states are unchanged. The only added application state is the router's last report, written only by its onError callback.

| Report state | Route error callback | Normal render/navigation | Document reload/home | Router unmount |
|---|---|---|---|---|
| Empty | Report original error; store error and ID | Remain empty | New document starts empty | Discard |
| Reported | Replace with new original error and ID | Retain; ID displayed only for identical error | New document starts empty | Discard |

Invariant: a displayed route ID belongs to its exact original error; report state cannot trigger another capture. No callback, input or query is serialized into the report. An unconfigured client does not show a synthetic report ID. Google failure only unmounts its own subtree. Reload/home controls require no router, auth or query provider.

## Verification plan

- Inject the reported TypeError into Google renderButton after entering email/password: form values and submission remain usable, one local SDK capture has google-sign-in tag.
- Trigger route render and lazy-load errors in StrictMode: custom recovery page, one capture, correct ID, no exception text.
- Trigger an application error outside the router: same localized recovery, application tag.
- Verify normal navigation/loading, all five locales and DSN-off behavior.
- Real browser: verify login fallback and SDK envelope using a local transport; translate attribute inheritance includes portals. Simulate translation replacing a React text node to validate recovery if an extension ignores opt-out.
- Typecheck, relevant unit tests, lint, build and chunk checks. Record actual results below before submitting the PR.

## Results (2026-10-10)

- Regression first: injecting the reported Google SDK TypeError made the original login-page test fail; the isolated boundary passed with entered values and email submission preserved. Mocked email API submission is unit coverage, not a live authentication E2E.
- The existing router-mount guard was adapted for the new context wrapper. A mutation that wrapped the provider in Suspense made it fail; the restored implementation passed.
- 89 frontend tests in 13 files passed: Google/login, route reporting, application recovery, route loading/preload/guards, locale switching and monitoring privacy. Six product-guide coverage tests passed. Web typecheck and scoped ESLint passed.
- `pnpm build` passed all seven Turbo tasks; `verify:chunks` confirmed 12 separate page chunks and a 14-file entry closure. Repository lint passed all 30 checks; dependency rules passed.
- Chromium with a local Sentry transport: Google renderButton TypeError produced one `google-sign-in` event, retained both entered form values, and left the email sign-in button enabled. No events were sent to production Sentry.
- Replacing a React-owned text node with a translated `font` element reproduced a real DOM `NotFoundError`. The route displayed localized recovery, emitted one `route` event, hid raw exception text, and a reload created a new document with the original page restored.
- An error outside the router emitted one `application` event. Home navigation created a new document at `/`. Recovery at a 390-pixel viewport had no horizontal overflow.
- The actual project creation dialog was mounted outside the React root and inherited `translate=false`; closing it with Escape and reopening produced no captured errors. Desktop and mobile screenshots were inspected.
- Browser fixtures were removed before the production build. Logs and screenshots remain local in ignored `node_modules/frontend-resilience-*` paths; they are not shipped in the PR.

### Verification limits

The complete default smoke suite was attempted but stopped at its database preflight: `DATABASE_URL` is unset in this independent worktree. The local server, PostgreSQL/Yjs databases and Redis are not configured here. Full live email authentication and project-creation E2E were not run; no production credentials were requested or accessed. The reported Google SDK error was injected into its render lifecycle; this verifies containment, not a repair of Google's iOS/in-app-browser compatibility. External translation was simulated by the known DOM replacement pattern; arbitrary extensions can ignore translation declarations.
