const { app, BrowserWindow, session, shell } = require('electron')
const http = require('http')
const path = require('path')

app.setName('Enterprise System')

/** Cloudflare workers ring (primary + standbys). The primary hostname is
 * intermittently unreachable on some networks, so every worker request is
 * retried against the standbys and the last working host is remembered. */
const MEXC_PROXY_HOSTS = [
  'mexc-proxy-b.mexc-standby.workers.dev',
  'mexc-proxy-f.mexc-f.workers.dev',
  'mexc-proxy-c.mexc-c.workers.dev',
  'mexc-proxy.sergiodecaux.workers.dev',
]

const ADVISOR_HOSTS = [
  'ai-advisor.mexc-standby.workers.dev',
  'ai-advisor.mexc-f.workers.dev',
  'ai-advisor.mexc-c.workers.dev',
  'ai-advisor.sergiodecaux.workers.dev',
]

const PREFERRED_TTL_MS = 5 * 60_000
let preferredProxyHost = ''
let preferredProxyAt = 0
let preferredAdvisorHost = ''
let preferredAdvisorAt = 0

const responseCache = new Map()
const MAX_CACHE_ENTRIES = 300

function orderHosts(hosts, preferred, preferredAt) {
  const fresh = preferred && Date.now() - preferredAt < PREFERRED_TTL_MS
  const first = fresh && hosts.includes(preferred) ? preferred : hosts[0]
  return [first, ...hosts.filter((h) => h !== first)]
}

function cacheTtlFor(target) {
  try {
    const u = new URL(target)
    if (u.pathname === '/mexc/api/v1/contract/ticker') return 8_000
    if (u.pathname === '/market-context') return 15_000
  } catch {
    /* ignore */
  }
  return 0
}

function rememberProxyHost(host) {
  preferredProxyHost = host
  preferredProxyAt = Date.now()
}

function rememberAdvisorHost(host) {
  preferredAdvisorHost = host
  preferredAdvisorAt = Date.now()
}

function buildCandidates(target) {
  const u = new URL(target)
  const pathAndQuery = `${u.pathname}${u.search}`
  const candidates = []

  const pushProxyRing = () => {
    const hosts = orderHosts(MEXC_PROXY_HOSTS, preferredProxyHost, preferredProxyAt)
    for (const host of hosts) {
      candidates.push({ url: `https://${host}${pathAndQuery}`, host, direct: false })
    }
  }

  const pushAdvisorRing = () => {
    const hosts = orderHosts(ADVISOR_HOSTS, preferredAdvisorHost, preferredAdvisorAt)
    for (const host of hosts) {
      candidates.push({ url: `https://${host}${pathAndQuery}`, host, direct: false })
    }
  }

  if (u.hostname.startsWith('ai-advisor')) {
    pushAdvisorRing()
    return candidates
  }

  if (pathAndQuery.startsWith('/mexc/') || pathAndQuery === '/mexc') {
    const suffix = pathAndQuery.slice('/mexc'.length) || '/'
    candidates.push({
      url: `https://contract.mexc.com${suffix}`,
      host: 'contract.mexc.com',
      direct: true,
    })
    pushProxyRing()
    return candidates
  }

  if (pathAndQuery.startsWith('/mexc-spot/') || pathAndQuery === '/mexc-spot') {
    const suffix = pathAndQuery.slice('/mexc-spot'.length) || '/'
    candidates.push({
      url: `https://api.mexc.com${suffix}`,
      host: 'api.mexc.com',
      direct: true,
    })
    pushProxyRing()
    return candidates
  }

  if (pathAndQuery.startsWith('/binance-fapi/') || pathAndQuery === '/binance-fapi') {
    const suffix = pathAndQuery.slice('/binance-fapi'.length) || '/'
    candidates.push({
      url: `https://fapi.binance.com${suffix}`,
      host: 'fapi.binance.com',
      direct: true,
    })
    pushProxyRing()
    return candidates
  }

  if (pathAndQuery.startsWith('/news/fg/') || pathAndQuery === '/news/fg') {
    const suffix = pathAndQuery.slice('/news/fg'.length) || '/'
    candidates.push({
      url: `https://api.alternative.me${suffix}`,
      host: 'api.alternative.me',
      direct: true,
    })
    pushProxyRing()
    return candidates
  }

  // `/news/panic`, `/news/rss`, `/market-context`, `/telegram/*`,
  // `/elite/*`, `/scanner`, `/vane/*` — served by the worker only.
  pushProxyRing()
  return candidates
}

async function fetchUpstream(target, init) {
  const cacheTtl = init.method === 'GET' ? cacheTtlFor(target) : 0
  if (cacheTtl > 0) {
    const hit = responseCache.get(target)
    if (hit && Date.now() - hit.at < cacheTtl) return hit
  }

  const candidates = buildCandidates(target)
  let lastError = null

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    const isLast = i === candidates.length - 1
    const timeout = candidate.direct ? 15_000 : 8_000

    try {
      const upstream = await fetch(candidate.url, {
        ...init,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      })

      if ((upstream.status === 429 || upstream.status >= 500) && !isLast) {
        lastError = new Error(`HTTP ${upstream.status} from ${candidate.host}`)
        continue
      }

      const body = Buffer.from(await upstream.arrayBuffer())
      const result = {
        at: Date.now(),
        status: upstream.status,
        contentType: upstream.headers.get('content-type') || 'application/octet-stream',
        body,
      }

      if (cacheTtl > 0 && result.status >= 200 && result.status < 300) {
        if (responseCache.size >= MAX_CACHE_ENTRIES) {
          const oldest = responseCache.keys().next().value
          responseCache.delete(oldest)
        }
        responseCache.set(target, result)
      }

      if (candidate.host !== 'contract.mexc.com' && candidate.host !== 'api.mexc.com' &&
          candidate.host !== 'fapi.binance.com' && candidate.host !== 'api.alternative.me') {
        if (candidate.host.startsWith('ai-advisor')) rememberAdvisorHost(candidate.host)
        else rememberProxyHost(candidate.host)
      }

      return result
    } catch (err) {
      lastError = err
    }
  }

  throw lastError ?? new Error('No upstream available')
}

/**
 * Chromium on some Windows networks cannot reach *.workers.dev directly
 * (connection reset / DNS timeouts), while Node's fetch can. This loopback
 * proxy forwards worker traffic through Node, with a standby ring and
 * direct upstreams for market data.
 */
function startLoopbackProxy() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Alert-Secret, Authorization, Accept'
      )
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      res.setHeader('Access-Control-Max-Age', '86400')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      let target = ''
      try {
        const requestUrl = new URL(req.url, 'http://127.0.0.1')
        target = requestUrl.searchParams.get('url') ?? ''
        if (!target) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing url parameter' }))
          return
        }

        const parsed = new URL(target)
        if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.workers.dev')) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Target host is not allowed' }))
          return
        }

        const headers = {}
        for (const [name, value] of Object.entries(req.headers)) {
          if (
            name === 'host' ||
            name === 'origin' ||
            name === 'referer' ||
            name === 'connection' ||
            name === 'content-length' ||
            name === 'accept-encoding'
          ) {
            continue
          }
          headers[name] = Array.isArray(value) ? value.join(', ') : value
        }
        if (!headers['user-agent']) headers['user-agent'] = 'EnterpriseSystem/2.0'

        const init = { method: req.method, headers }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          init.body = Buffer.concat(chunks)
        }

        const result = await fetchUpstream(target, init)
        res.writeHead(result.status, {
          'Content-Type': result.contentType,
          'Cache-Control': 'no-store',
        })
        res.end(result.body)
      } catch (err) {
        console.error('[loopback-proxy]', target, err)
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function installWorkerProxy() {
  const port = await startLoopbackProxy()
  const proxyBase = `http://127.0.0.1:${port}/__worker_proxy`
  const filter = { urls: ['https://*.workers.dev/*'] }

  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    callback({
      redirectURL: `${proxyBase}?url=${encodeURIComponent(details.url)}`,
    })
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0a0a0a',
    title: 'Enterprise System',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(async () => {
  try {
    await installWorkerProxy()
  } catch (err) {
    console.error('[loopback-proxy] failed to start', err)
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
