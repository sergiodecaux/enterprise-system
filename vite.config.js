// @ts-nocheck
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const RSS_ALLOWED = [
    'coindesk.com',
    'cointelegraph.com',
    'decrypt.co',
    'theblock.co',
];
/** Dev middleware: /news/rss?url=… → whitelist fetch */
function newsRssProxy() {
    return {
        name: 'news-rss-proxy',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const rawUrl = req.url ?? '';
                if (!rawUrl.startsWith('/news/rss')) {
                    next();
                    return;
                }
                void (async () => {
                    try {
                        const full = new URL(rawUrl, 'http://localhost');
                        const rssUrl = full.searchParams.get('url');
                        if (!rssUrl) {
                            res.statusCode = 400;
                            res.end('Missing url param');
                            return;
                        }
                        const parsed = new URL(rssUrl);
                        if (!RSS_ALLOWED.some((d) => parsed.hostname.indexOf(d) !== -1)) {
                            res.statusCode = 403;
                            res.end('Domain not allowed');
                            return;
                        }
                        const upstream = await fetch(rssUrl, {
                            headers: {
                                Accept: 'application/rss+xml, text/xml, */*',
                                'User-Agent': 'EnterpriseSystem/2.0',
                            },
                        });
                        const body = new Uint8Array(await upstream.arrayBuffer());
                        res.statusCode = upstream.status;
                        res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'application/xml');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.end(body);
                    }
                    catch (err) {
                        res.statusCode = 502;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({
                            success: false,
                            message: err instanceof Error ? err.message : 'Proxy error',
                        }));
                    }
                })();
            });
        },
    };
}
export default defineConfig({
    plugins: [react(), newsRssProxy()],
    base: './',
    server: {
        proxy: {
            '/mexc': {
                target: 'https://contract.mexc.com',
                changeOrigin: true,
                secure: true,
                rewrite: (path) => path.replace(/^\/mexc/, ''),
            },
            '/news/panic': {
                target: 'https://cryptopanic.com',
                changeOrigin: true,
                secure: true,
                rewrite: (path) => path.replace(/^\/news\/panic/, ''),
            },
            '/news/fg': {
                target: 'https://api.alternative.me',
                changeOrigin: true,
                secure: true,
                rewrite: (path) => path.replace(/^\/news\/fg/, ''),
            },
        },
    },
    optimizeDeps: {
        include: [
            'three',
            '@react-three/fiber',
            '@react-three/drei',
            'lightweight-charts',
        ],
    },
    build: {
        target: 'es2020',
        minify: true,
        rollupOptions: {
            output: {
                manualChunks: {
                    'react-vendor': ['react', 'react-dom'],
                    'chart-vendor': ['lightweight-charts'],
                    'three-vendor': ['three', '@react-three/fiber', '@react-three/drei'],
                    'i18n-vendor': [
                        'i18next',
                        'react-i18next',
                        'i18next-browser-languagedetector',
                    ],
                },
            },
        },
    },
});
