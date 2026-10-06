// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const RSS_ALLOWED = [
  'coindesk.com',
  'cointelegraph.com',
  'decrypt.co',
  'theblock.co',
]

/** Dev middleware: /news/rss?url=… → whitelist fetch */
function newsRssProxy(): Plugin {
  return {
    name: 'news-rss-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? ''
        if (!rawUrl.startsWith('/news/rss')) {
          next()
          return
        }

        void (async () => {
          try {
            const full = new URL(rawUrl, 'http://localhost')
            const rssUrl = full.searchParams.get('url')
            if (!rssUrl) {
              res.statusCode = 400
              res.end('Missing url param')
              return
            }
            const parsed = new URL(rssUrl)
            if (!RSS_ALLOWED.some((d) => parsed.hostname.indexOf(d) !== -1)) {
              res.statusCode = 403
              res.end('Domain not allowed')
              return
            }
            const upstream = await fetch(rssUrl, {
              headers: {
                Accept: 'application/rss+xml, text/xml, */*',
                'User-Agent': 'EnterpriseSystem/2.0',
              },
            })
            const body = new Uint8Array(await upstream.arrayBuffer())
            res.statusCode = upstream.status
            res.setHeader(
              'Content-Type',
              upstream.headers.get('Content-Type') || 'application/xml'
            )
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(body)
          } catch (err) {
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                success: false,
                message: err instanceof Error ? err.message : 'Proxy error',
              })
            )
          }
        })()
      })
    },
  }
}

/**
 * Telegram WebView caches index.html. Load hashed assets from version.json
 * (fetched with a unique query) so Mini App picks up a new Pages deploy.
 */
function telegramCacheBust(): Plugin {
  return {
    name: 'telegram-cache-bust',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const cssRe =
          /<link rel="stylesheet" crossorigin href="([^"]+)">/
        const jsRe =
          /<script type="module" crossorigin src="([^"]+)"><\/script>/
        const css = html.match(cssRe)?.[1] ?? ''
        const js = html.match(jsRe)?.[1] ?? ''
        const boot = `<script>
(function () {
  var cssFallback = ${JSON.stringify(css)};
  var jsFallback = ${JSON.stringify(js)};
  function addCss(href) {
    if (!href) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.crossOrigin = 'anonymous';
    l.href = href;
    document.head.appendChild(l);
  }
  function addJs(src) {
    if (!src) return;
    var s = document.createElement('script');
    s.type = 'module';
    s.crossOrigin = 'anonymous';
    s.src = src;
    document.body.appendChild(s);
  }
  fetch('./version.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (v) {
      addCss((v && v.css) || cssFallback);
      addJs((v && v.entry) || jsFallback);
    })
    .catch(function () {
      addCss(cssFallback);
      addJs(jsFallback);
    });
})();
</script>`
        let out = html
        if (css) out = out.replace(cssRe, '')
        if (js) out = out.replace(jsRe, boot)
        else out = out.replace('</body>', boot + '</body>')
        return out
      },
    },
    closeBundle() {
      const dist = path.resolve('dist')
      const htmlPath = path.join(dist, 'index.html')
      if (!fs.existsSync(htmlPath)) return
      const html = fs.readFileSync(htmlPath, 'utf8')
      const css =
        html.match(/cssFallback = "([^"]+)"/)?.[1] ??
        html.match(/href="(\.\/assets\/[^"]+\.css)"/)?.[1] ??
        ''
      const entry =
        html.match(/jsFallback = "([^"]+)"/)?.[1] ??
        html.match(/src="(\.\/assets\/[^"]+\.js)"/)?.[1] ??
        ''
      const id = String(process.env.GITHUB_SHA || Date.now()).slice(0, 12)
      fs.writeFileSync(
        path.join(dist, 'version.json'),
        JSON.stringify({ id, entry, css, t: Date.now() })
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), newsRssProxy(), telegramCacheBust()],
  base: './',
  server: {
    proxy: {
      '/mexc': {
        target: 'https://contract.mexc.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/mexc/, ''),
      },
      '/mexc-spot': {
        target: 'https://api.mexc.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/mexc-spot/, ''),
      },
      '/binance-fapi': {
        target: 'https://fapi.binance.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/binance-fapi/, ''),
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
})
