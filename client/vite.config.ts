import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

// Build variants:
//  - default  → the web app / Windows-served SPA (PWA enabled, base '/').
//  - demo     → static demo (VITE_DEMO=true, sub-path base, no SW). The base
//               defaults to the GitHub Pages path; set VITE_DEMO_BASE to build
//               the demo for another host (e.g. '/demo/' for openfamily.fr).
//  - native   → Capacitor Android shell (`vite build --mode native`): base '/'
//               and NO service worker (the app shell is bundled in the APK).
export default defineConfig(({ mode }) => {
    const isDemo = process.env.VITE_DEMO === 'true';
    const isNativeBuild = mode === 'native';
    const usePwa = !isDemo && !isNativeBuild;

    return {
        base: isDemo ? (process.env.VITE_DEMO_BASE || '/OpenFamily/demo/') : '/',
        plugins: [
            react(),
            ...(usePwa ? [VitePWA({
                registerType: 'autoUpdate',
                strategies: 'injectManifest',
                srcDir: 'src',
                filename: 'sw.js',
                injectManifest: {
                    // The app bundle includes the Firebase SDK and exceeds Workbox's 2 MiB default.
                    maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
                },
                includeAssets: ['chocomelerplan-32.png', 'chocomelerplan-16.png', 'chocomelerplan-180.png', 'chocomelerplan-logo.png'],
                manifest: {
                    name: 'chocomelerplan',
                    short_name: 'chocomelerplan',
                    description: 'Application de gestion familiale',
                    theme_color: '#DC4A60',
                    background_color: '#F7F2E9',
                    display: 'standalone',
                    icons: [
                        { src: '/chocomelerplan-192.png', sizes: '192x192', type: 'image/png' },
                        { src: '/chocomelerplan-512.png', sizes: '512x512', type: 'image/png' },
                    ],
                },
                devOptions: { enabled: false },
            })] : []),
        ],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
            },
        },
        server: {
            port: 5173,
            proxy: {
                '/api': {
                    target: process.env.VITE_API_URL || 'http://localhost:3001',
                    changeOrigin: true,
                },
            },
        },
    };
});
