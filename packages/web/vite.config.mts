import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { visualizer } from 'rollup-plugin-visualizer';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { resolveDevPort } from './dev-ports.mjs';
import { resolveProxyTargets } from './proxy-targets.mjs';

// need to add breatic Index to serve
// import sirv from 'sirv'
// const breaticIndex = path.resolve(__dirname, './breatic');

export default defineConfig(({ command, mode }) => {
  // Load .env from the monorepo root (shared by backend + frontend). The third
  // arg is an empty prefix, which makes loadEnv return EVERY var rather than
  // only the VITE_-prefixed ones — that is how GOOGLE_CLIENT_ID (no prefix,
  // injected via `define` below) is readable here at all. Reading a var here
  // does not ship it to the client; only `define` and import.meta.env do.
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const sentryAuthToken = env.VITE_SENTRY_AUTH_TOKEN;

  // Dev-server port + proxy targets, derived from .env so several worktrees can
  // run `pnpm dev` at once without fighting over the same ports (#1831).
  // Defaults reproduce the single-worktree setup exactly, so an .env without
  // these vars behaves as before. Shared with playwright.config.ts so the smoke
  // target can never aim at a port the dev server did not bind.
  const devPort = resolveDevPort(mode, __dirname);
  const { apiTarget: devApiTarget, wsTarget: devWsTarget } =
    resolveProxyTargets(mode, __dirname);
  // Sentry plugin only with a token AND on `build`: dev must never cut a
  // release or upload source maps.
  const useSentryPlugin = Boolean(sentryAuthToken && command === 'build');

  return {
    // Load .env from monorepo root so frontend + backend share one file
    envDir: path.resolve(__dirname, '../..'),
    // Inject backend-only env vars into frontend (avoids duplicating VITE_ prefixed vars)
    define: {
      '__GOOGLE_CLIENT_ID__': JSON.stringify(env.GOOGLE_CLIENT_ID || ''),
    },
    plugins: [
      react(),
      // Tailwind 4 vite plugin — processes `@import "tailwindcss"` +
      // `@theme {}` directives in CSS and generates utility classes.
      // Replaces the v3 PostCSS plugin path. No JS config: there is no
      // `@config` directive in any CSS, so a tailwind.config.ts is never
      // loaded — every token lives in CSS `@theme` (tokens.css). The old
      // config was removed 2026-06-13 (dead: not loaded, its space/btn/
      // avatar/icon utilities had 0 usages, text-base comes from @theme).
      tailwindcss(),
      // svg-icons plugin removed by the web v14 reset (src/assets/svg/ was
      // deleted); re-add per future PR if any module needs sprite icons.
      ...(useSentryPlugin
        ? [
          sentryVitePlugin({
            org: 'orime',
            project: 'breatic_web',
            authToken: sentryAuthToken,
            release: { name: env.VITE_APP_VERSION, inject: true },
            telemetry: false,
            sourcemaps: {
              ignore: ['**/antd-*.js', '**/antd-*.js.map', '**/*ant-design*.js', '**/*ant-design*.js.map'],
            },
            errorHandler: (err: Error) => {
              const msg = err.message || '';
              if (msg.includes('original location') || msg.includes('antd') || msg.includes('@ant-design')) {
                return;
              }
              console.warn('[sentry-vite-plugin]', err);
            },
          }),
        ]
        : []),
      // Writes a bundle-size report to dist/breatic/stats.html — open it after
      // a build to see what each chunk weighs.
      visualizer({
        open: false,
        filename: path.resolve(__dirname, 'dist/breatic/stats.html'),
        gzipSize: true,
      }),
    ],
    // Served from the nginx root, identically in dev and in a build. Sub-path
    // hosting is not supported: this is hard-coded, and same-origin is a
    // requirement anyway (the frontend resolves the API and WebSocket URLs
    // from `window.location` — see docs/DEPLOY.md "Canonical domain").
    base: '/',
    root: path.resolve(__dirname, 'src'),
    publicDir: path.resolve(__dirname, 'public'),
    resolve: {
      alias: {
        '@web': path.resolve(__dirname, './src'),
        '@locales': path.resolve(__dirname, '../../locales'),
      },
    },
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
    },
    worker: {
      format: 'es', // ES module type
    },
    build: {
      target: 'esnext',
      // dist/breatic is what `Dockerfile.web` copies straight into the nginx
      // web root — renaming it breaks the image build, not just this config.
      outDir: path.resolve(__dirname, 'dist/breatic'),
      emptyOutDir: true,
      sourcemap: true, // Required — the Sentry plugin uploads these.
      rollupOptions: {
        input: path.resolve(__dirname, 'src/index.html'),
        onwarn(warning, defaultHandler) {
          // Silence Rollup's "Can't resolve original location of error"
          // sourcemap noise from third-party packages.
          // NOTE: the `antd` conditions below are dead — antd was removed from
          // this app (no dependency, no import remains). Left untouched rather
          // than cleaned up as drive-by scope; see task #1833.
          const msg = String(warning.message || '');
          if (msg.includes('sourcemap') && (msg.includes('original location') || msg.includes('antd'))) {
            return;
          }
          if (msg.includes('antd') && msg.includes('sourcemap')) return;
          defaultHandler(warning);
        },
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          // Mark node_modules as an ignore list so Rollup stops trying to
          // resolve third-party source maps (the "Can't resolve original
          // location" warnings above).
          sourcemapIgnoreList: (sourcePath: string) => sourcePath.includes('node_modules'),
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (id.includes('react-dom') || id.includes('react/') || id.includes('react-router') || id.includes('scheduler')) {
              return 'react-vendor';
            }
            if (id.includes('antd') || id.includes('@ant-design')) {
              return 'antd';
            }
            if (id.includes('@xyflow')) {
              return 'xyflow';
            }
            if (id.includes('lottie-web')) return 'lottie';
            if (id.includes('video.js') || id.includes('videojs')) return 'videojs';
            if (id.includes('wavesurfer')) return 'wavesurfer';
            if (id.includes('xlsx') || id.includes('xlsx/')) return 'xlsx';
            // mammoth is deliberately NOT split out: in its own chunk its
            // internal deps blow up with `createBodyReader is undefined`.
            if (id.includes('react-moveable')) return 'moveable';
            if (id.includes('swiper')) return 'swiper';
            // @dnd-kit is deliberately NOT split out either: it reaches for
            // React.useLayoutEffect and breaks in a separate chunk.
            if (id.includes('i18next') || id.includes('react-i18next')) return 'i18n';
            if (id.includes('dompurify')) return 'dompurify';
            // The Aliyun OSS SDK is ~1.5MB, so it gets its own chunk rather
            // than riding along in a shared one.
            // NOTE: dead today — `ali-oss` is a dependency but nothing under
            // packages/web/src imports it, so this branch never fires and the
            // chunk is never produced. Same situation as the antd branches
            // above; both are catalogued in task #1833.
            if (id.includes('ali-oss')) return 'ali-oss';
          },
        },
      },
    },
    server: {
      port: devPort,
      // Fail instead of silently taking the next free port. Vite's default is
      // to hop 8000 -> 8001 when the port is busy, but playwright builds its
      // baseURL from VITE_DEV_PORT — so a silent hop points the smoke run at
      // whatever else is on 8000, which with several worktrees running is
      // another worktree's frontend (#1831). Every other collision in this
      // setup fails loudly; this was the last one that degraded quietly.
      strictPort: true,
      open: '/',
      // Dev server, API and Collab run on three different ports — different
      // origins from the browser's perspective. Proxy /api, /uploads, /ws
      // through Vite so frontend code can use relative URLs (same-origin)
      // in dev just like it does in prod (where nginx does the same job).
      // Dev proxy MUST target the local services spun up by `pnpm dev` /
      // `pnpm dev:collab` / `pnpm db:migrate` — never a remote deployment.
      // Pointing these at thinkai.cc / breatic.ai silently routes every
      // developer's traffic to shared infra and makes local code changes
      // untestable (see BUG-2 post-mortem).
      proxy: {
        '/api/': {
          target: devApiTarget,
          changeOrigin: true,
        },
        '/uploads/': {
          target: devApiTarget,
          changeOrigin: true,
        },
        // Yjs client connects to `/ws` (without trailing slash), so proxy key
        // must also match `/ws` to avoid bypassing Vite proxy in dev.
        '/ws': {
          target: devWsTarget,
          ws: true,
          changeOrigin: true,
          // Explicit cookie forwarding on the WS upgrade request.
          // `http-proxy` (under the hood) forwards request headers on
          // HTTP proxies by default, but the WS-upgrade code path has
          // historically been less reliable about `Cookie` when
          // `changeOrigin: true` rewrites the Host header — issues
          // open against http-party/node-http-proxy track this. The
          // `proxyReqWs` hook is the documented way to guarantee the
          // session cookie reaches the collab process (at `devWsTarget`,
          // derived from `COLLAB_PORT`) so `onAuthenticate` can parse it
          // out of `requestHeaders.cookie` — collab looks the cookie up
          // by `sessionCookieName()`, which is deployment-scoped (#1831),
          // so nothing here may assume a literal name. Without this hook
          // the WS auth fails
          // (4401) even when the same browser session can hit /api
          // fine, because the API proxy keeps the cookie and the WS
          // proxy was silently dropping it.
          configure(proxy) {
            proxy.on('proxyReqWs', (proxyReq, req) => {
              if (req.headers.cookie) {
                proxyReq.setHeader('Cookie', req.headers.cookie);
              }
            });
          },
        },
      },
    },
  };
});

