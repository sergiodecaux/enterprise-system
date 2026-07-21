# MEXC Contract CORS Proxy

Transparent proxy for public MEXC futures market data. Required for GitHub Pages / Telegram Mini App (browser CORS blocks direct calls to `contract.mexc.com`).

## Deploy

```bash
cd workers/mexc-proxy
npx wrangler deploy
```

Copy the worker URL, e.g. `https://mexc-proxy.<account>.workers.dev`.

## App config

In production build:

```bash
VITE_MEXC_PROXY_URL=https://mexc-proxy.<account>.workers.dev npm run build
```

Locally, Vite proxies `/mexc` → `https://contract.mexc.com` (see root `vite.config.ts`). No env var needed for `npm run dev`.

## Paths

Client requests: `{VITE_MEXC_PROXY_URL}/mexc/api/v1/contract/...`  
Worker forwards to: `https://contract.mexc.com/api/v1/contract/...`

News: `{VITE_MEXC_PROXY_URL}/news/panic/...`, `/news/fg/...`, `/news/rss?url=...`
