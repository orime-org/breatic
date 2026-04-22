import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { visualizer } from 'rollup-plugin-visualizer';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons';

// need to add breatic Index to serve
// import sirv from 'sirv'
// const breaticIndex = path.resolve(__dirname, './breatic');

export default defineConfig(({ command, mode }) => {
  // 在配置内加载 .env，确保 VITE_SENTRY_AUTH_TOKEN 等能被读到
  // Load .env from monorepo root (shared by backend + frontend)
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const sentryAuthToken = env.VITE_SENTRY_AUTH_TOKEN;
  // 仅在有 token 且执行 build 时启用 Sentry 插件（dev 不创建 release、不上传 source map）
  const useSentryPlugin = Boolean(sentryAuthToken && command === 'build');

  return {
    // Load .env from monorepo root so frontend + backend share one file
    envDir: path.resolve(__dirname, '../..'),
    // Inject backend-only env vars into frontend (avoids duplicating VITE_ prefixed vars)
    define: {
      'import.meta.env.VITE_LOGIN_MODE': JSON.stringify(env.LOGIN_MODE || 'WithAccount'),
      '__GOOGLE_CLIENT_ID__': JSON.stringify(env.GOOGLE_CLIENT_ID || ''),
    },
    plugins: [
      react(),
      createSvgIconsPlugin({
        // 指定需要缓存的图标文件夹
        iconDirs: [path.resolve(__dirname, 'src/assets/svg')],
        // 指定symbolId格式，包含目录前缀和文件名
        symbolId: 'icon-[dir]-[name]',
        // 自定义插入位置
        inject: 'body-last',
        // 自定义dom id
        customDomId: '__svg__icons__dom__',
      }),
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
      // build 后打开 dist/breatic/stats.html 查看各 chunk 体积
      visualizer({
        open: false,
        filename: path.resolve(__dirname, 'dist/breatic/stats.html'),
        gzipSize: true,
      }),
    ],
    // 前端部署在 nginx 根路径（/）下，dev 和 build 统一。
    // 如需挂在子路径，通过 VITE_PUBLIC_PATH 覆盖。
    base: '/',
    root: path.resolve(__dirname, 'src'),
    publicDir: path.resolve(__dirname, 'public'),
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
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
      // 输出到 dist/breatic，便于复制到主项目：主项目 dist 结构为 index.html, 404/, login/, breatic/
      outDir: path.resolve(__dirname, 'dist/breatic'),
      emptyOutDir: true,
      sourcemap: true, // 必须开启，上传 source map
      rollupOptions: {
        input: path.resolve(__dirname, 'src/index.html'),
        onwarn(warning, defaultHandler) {
          // 忽略 antd / source map 相关警告（"Can't resolve original location of error" 等）
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
          // node_modules 标为 ignoreList，减轻 Rollup 解析 antd 等第三方 source map 时的 "Can't resolve original location" 警告
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
            // mammoth 内部依赖在单独 chunk 中会报 createBodyReader undefined，不拆
            if (id.includes('react-moveable')) return 'moveable';
            if (id.includes('swiper')) return 'swiper';
            // @dnd-kit 依赖 React.useLayoutEffect，不能单独拆 chunk
            if (id.includes('i18next') || id.includes('react-i18next')) return 'i18n';
            if (id.includes('dompurify')) return 'dompurify';
            // 阿里云 OSS SDK 约 1.5MB，单独拆出，仅在 Project/VideoEditor 上传时加载
            if (id.includes('ali-oss')) return 'ali-oss';
          },
        },
      },
    },
    server: {
      port: 8000,
      open: '/',
      // Dev server runs on :8000, API on :3000, Collab on :1234 — different
      // origins from the browser's perspective. Proxy /api, /uploads, /ws
      // through Vite so frontend code can use relative URLs (same-origin)
      // in dev just like it does in prod (where nginx does the same job).
      proxy: {
        '/api/': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
        '/uploads/': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
        '/ws': {
          target: 'ws://localhost:1234',
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});

