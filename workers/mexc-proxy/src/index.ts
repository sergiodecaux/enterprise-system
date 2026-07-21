/**
 * Cloudflare Worker — CORS proxy for MEXC + News sources.
 * Deploy: cd workers/mexc-proxy && npx wrangler deploy
 */

const MEXC_ORIGIN = 'https://contract.mexc.com'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

const RSS_ALLOWED = [
  'coindesk.com',
  'cointelegraph.com',
  'decrypt.co',
  'theblock.co',
]

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', {
        status: 405,
        headers: CORS_HEADERS,
      })
    }

    const url = new URL(request.url)
    const path = url.pathname

    if (path.startsWith('/news/rss')) {
      const rssUrl = url.searchParams.get('url')
      if (!rssUrl) {
        return new Response('Missing url param', {
          status: 400,
          headers: CORS_HEADERS,
        })
      }
      try {
        const parsed = new URL(rssUrl)
        if (!RSS_ALLOWED.some((d) => parsed.hostname.includes(d))) {
          return new Response('Domain not allowed', {
            status: 403,
            headers: CORS_HEADERS,
          })
        }
      } catch {
        return new Response('Invalid url', {
          status: 400,
          headers: CORS_HEADERS,
        })
      }
      return proxyFetch(rssUrl, CORS_HEADERS)
    }

    let targetBase = ''
    let targetPath = path

    if (path.startsWith('/news/panic')) {
      targetBase = 'https://cryptopanic.com'
      targetPath = path.replace('/news/panic', '') || '/'
    } else if (path.startsWith('/news/fg')) {
      targetBase = 'https://api.alternative.me'
      targetPath = path.replace('/news/fg', '') || '/'
    } else if (path.startsWith('/mexc')) {
      targetBase = MEXC_ORIGIN
      targetPath = path.replace('/mexc', '') || '/'
    } else {
      return new Response('Route not found', {
        status: 404,
        headers: CORS_HEADERS,
      })
    }

    const target = `${targetBase}${targetPath}${url.search}`
    return proxyFetch(target, CORS_HEADERS)
  },
}

async function proxyFetch(
  targetUrl: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/xml, application/rss+xml, */*',
        'User-Agent': 'EnterpriseSystem/2.0',
      },
    })

    const body = await upstream.arrayBuffer()
    const headers = new Headers(corsHeaders)
    headers.set(
      'Content-Type',
      upstream.headers.get('Content-Type') || 'application/json'
    )
    headers.set('Cache-Control', 'public, max-age=60')

    return new Response(body, { status: upstream.status, headers })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Proxy error'
    return new Response(JSON.stringify({ success: false, message: msg }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
}
