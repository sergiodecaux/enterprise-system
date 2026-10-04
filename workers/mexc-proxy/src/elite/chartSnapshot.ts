import { buildHtfLiquidityMap, findSmartZone } from '../liquidityZones'
import { fetchKlinesCached } from '../vane/htfCache'
import type { Candle, Side, VaneKv } from '../vane/types'

const W = 480
const H = 268
const PAD_L = 52
const PAD_R = 86
const PAD_T = 26
const PAD_B = 22

export interface SnapshotScene {
  symbol: string
  side: Side
  entry: number
  target: number
  zoneLow: number
  zoneHigh: number
  magnetPrice?: number
  magnetLabel?: string
  caption: string
}

interface Rgb {
  r: number
  g: number
  b: number
}

const BG: Rgb = { r: 11, g: 16, b: 22 }
const GRID: Rgb = { r: 28, g: 36, b: 46 }
const TEXT: Rgb = { r: 210, g: 220, b: 230 }
const MUTED: Rgb = { r: 130, g: 142, b: 156 }
const GREEN: Rgb = { r: 46, g: 196, b: 126 }
const RED: Rgb = { r: 232, g: 93, b: 117 }
const ZONE: Rgb = { r: 56, g: 128, b: 210 }
const GOLD: Rgb = { r: 232, g: 196, b: 92 }
const MAGNET: Rgb = { r: 180, g: 140, b: 255 }

const FONT: Record<string, number[]> = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0e],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0e, 0x11, 0x10, 0x0e, 0x01, 0x11, 0x0e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0x04, 0x04],
  '-': [0, 0, 0, 0x0e, 0, 0, 0],
  '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  ':': [0, 0x04, 0, 0, 0, 0x04, 0],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '%': [0x19, 0x1a, 0x02, 0x04, 0x08, 0x0b, 0x13],
  В: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  Х: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  О: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  Д: [0x0f, 0x09, 0x09, 0x09, 0x09, 0x1f, 0x11],
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function adler32(buf: Uint8Array): number {
  let a = 1
  let b = 0
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]!) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type)
  const body = new Uint8Array(t.length + data.length)
  body.set(t, 0)
  body.set(data, t.length)
  const out = new Uint8Array(8 + body.length + 4)
  out.set(u32(data.length), 0)
  out.set(body, 4)
  out.set(u32(crc32(body)), 8 + body.length)
  return out
}

function zlibStore(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = []
  const max = 65535
  for (let off = 0; off < data.length; off += max) {
    const slice = data.subarray(off, Math.min(off + max, data.length))
    const last = off + max >= data.length
    const head = new Uint8Array(5 + slice.length)
    head[0] = last ? 1 : 0
    head[1] = slice.length & 255
    head[2] = (slice.length >>> 8) & 255
    head[3] = ~slice.length & 255
    head[4] = (~slice.length >>> 8) & 255
    head.set(slice, 5)
    blocks.push(head)
  }
  let total = 2 + 4
  for (const b of blocks) total += b.length
  const out = new Uint8Array(total)
  out[0] = 0x78
  out[1] = 0x01
  let p = 2
  for (const b of blocks) {
    out.set(b, p)
    p += b.length
  }
  out.set(u32(adler32(data)), p)
  return out
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy.buffer
}

async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  try {
    const cs = new CompressionStream('deflate')
    const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(cs)
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return zlibStore(data)
  }
}

async function encodePng(pixels: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const raw = new Uint8Array((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1)
    raw[row] = 0
    raw.set(pixels.subarray(y * w * 3, (y + 1) * w * 3), row + 1)
  }
  const ihdr = new Uint8Array(13)
  ihdr.set(u32(w), 0)
  ihdr.set(u32(h), 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const idat = await deflateZlib(raw)
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array())]
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

class Canvas {
  w: number
  h: number
  px: Uint8Array
  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.px = new Uint8Array(w * h * 3)
    this.fill(0, 0, w, h, BG)
  }
  idx(x: number, y: number): number {
    return (y * this.w + x) * 3
  }
  plot(x: number, y: number, c: Rgb, a = 1): void {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return
    const i = this.idx(xi, yi)
    if (a >= 1) {
      this.px[i] = c.r
      this.px[i + 1] = c.g
      this.px[i + 2] = c.b
      return
    }
    this.px[i] = Math.round(this.px[i]! * (1 - a) + c.r * a)
    this.px[i + 1] = Math.round(this.px[i + 1]! * (1 - a) + c.g * a)
    this.px[i + 2] = Math.round(this.px[i + 2]! * (1 - a) + c.b * a)
  }
  fill(x0: number, y0: number, x1: number, y1: number, c: Rgb, a = 1): void {
    const xa = Math.max(0, Math.min(this.w, Math.round(Math.min(x0, x1))))
    const xb = Math.max(0, Math.min(this.w, Math.round(Math.max(x0, x1))))
    const ya = Math.max(0, Math.min(this.h, Math.round(Math.min(y0, y1))))
    const yb = Math.max(0, Math.min(this.h, Math.round(Math.max(y0, y1))))
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) this.plot(x, y, c, a)
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, c: Rgb, w = 1): void {
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    let x = x0
    let y = y0
    for (;;) {
      for (let i = 0; i < w; i++) this.plot(x, y + i, c)
      if (Math.abs(x - x1) < 0.6 && Math.abs(y - y1) < 0.6) break
      const e2 = 2 * err
      if (e2 > -dy) {
        err -= dy
        x += sx
      }
      if (e2 < dx) {
        err += dx
        y += sy
      }
    }
  }
  text(x: number, y: number, s: string, c: Rgb, scale = 1): void {
    let cx = x
    for (const ch of s) {
      const g = FONT[ch] ?? FONT[ch.toUpperCase()] ?? FONT[' ']
      if (!g) {
        cx += 6 * scale
        continue
      }
      for (let row = 0; row < 7; row++) {
        const bits = g[row]!
        for (let col = 0; col < 5; col++) {
          if (bits & (0x10 >> col)) {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                this.plot(cx + col * scale + sx, y + row * scale + sy, c)
              }
            }
          }
        }
      }
      cx += 6 * scale
    }
  }
}

function fmtShort(n: number): string {
  if (!(n > 0)) return '-'
  if (n >= 1000) return n.toFixed(1)
  if (n >= 1) return n.toFixed(3)
  return n.toPrecision(3)
}

function yOf(price: number, min: number, max: number): number {
  const span = Math.max(max - min, 1e-12)
  return PAD_T + ((max - price) / span) * (H - PAD_T - PAD_B)
}

function arrowHead(c: Canvas, x1: number, y1: number, x0: number, y0: number, col: Rgb): void {
  const ang = Math.atan2(y1 - y0, x1 - x0)
  const L = 8
  c.line(x1, y1, x1 - L * Math.cos(ang - 0.45), y1 - L * Math.sin(ang - 0.45), col, 2)
  c.line(x1, y1, x1 - L * Math.cos(ang + 0.45), y1 - L * Math.sin(ang + 0.45), col, 2)
}

export async function renderSetupChartPng(
  candles: Candle[],
  scene: SnapshotScene
): Promise<Uint8Array | null> {
  const bars = candles.slice(-48)
  if (bars.length < 8) return null
  const c = new Canvas(W, H)
  let min = Math.min(...bars.map((b) => b[3]), scene.zoneLow, scene.entry, scene.target)
  let max = Math.max(...bars.map((b) => b[2]), scene.zoneHigh, scene.entry, scene.target)
  if (scene.magnetPrice) {
    min = Math.min(min, scene.magnetPrice)
    max = Math.max(max, scene.magnetPrice)
  }
  const pad = (max - min) * 0.08 || 1
  min -= pad
  max += pad

  const plotW = W - PAD_L - PAD_R
  const step = plotW / Math.max(bars.length, 1)

  c.text(8, 6, `${scene.symbol.replace('_USDT', '/USDT')} 15M`, TEXT, 1)
  const sideCol = scene.side === 'LONG' ? GREEN : RED
  c.text(W - 132, 6, `VHOD ${scene.side}`, sideCol, 1)

  for (let i = 1; i < 4; i++) {
    const y = PAD_T + ((H - PAD_T - PAD_B) * i) / 4
    c.line(PAD_L, y, W - PAD_R, y, GRID)
  }

  const z0 = yOf(scene.zoneHigh, min, max)
  const z1 = yOf(scene.zoneLow, min, max)
  c.fill(PAD_L, z0, W - PAD_R, z1, ZONE, 0.22)
  c.line(PAD_L, z0, W - PAD_R, z0, ZONE)
  c.line(PAD_L, z1, W - PAD_R, z1, ZONE)

  for (let i = 0; i < bars.length; i++) {
    const [, o, h, l, cl] = bars[i]!
    const x = PAD_L + i * step + step / 2
    const up = cl >= o
    const col = up ? GREEN : RED
    c.line(x, yOf(h, min, max), x, yOf(l, min, max), col)
    const yTop = yOf(Math.max(o, cl), min, max)
    const yBot = yOf(Math.min(o, cl), min, max)
    const hw = Math.max(1.2, step * 0.28)
    c.fill(x - hw, yTop, x + hw, Math.max(yBot, yTop + 1), col)
  }

  const lastX = PAD_L + (bars.length - 1) * step + step / 2
  const entryY = yOf(scene.entry, min, max)
  const tgtY = yOf(scene.target, min, max)
  const fuelX = PAD_L + plotW * 0.62
  const fuelY = entryY + (tgtY - entryY) * 0.38

  c.line(lastX, entryY, lastX + 64, tgtY, GOLD, 2)
  arrowHead(c, lastX + 64, tgtY, lastX, entryY, GOLD)
  c.fill(fuelX - 3, fuelY - 3, fuelX + 4, fuelY + 4, GOLD)
  c.text(fuelX + 6, fuelY - 8, 'FUEL', GOLD)

  c.fill(lastX - 4, entryY - 4, lastX + 5, entryY + 5, sideCol)
  c.line(W - PAD_R - 2, entryY, W - 4, entryY, sideCol, 2)
  c.text(W - 80, entryY - 14, 'ВХОД', sideCol)
  c.text(W - 80, entryY - 4, scene.side, sideCol)
  c.text(W - 80, entryY + 6, fmtShort(scene.entry), TEXT)

  if (scene.magnetPrice && scene.magnetLabel) {
    const my = yOf(scene.magnetPrice, min, max)
    c.line(PAD_L, my, W - PAD_R, my, MAGNET)
    const label = scene.magnetLabel.slice(0, 16).toUpperCase()
    c.text(PAD_L + 4, my - 9, label, MAGNET)
  }

  c.text(8, H - 14, fmtShort(max), MUTED)
  c.text(8, H - 24, fmtShort(min), MUTED)
  return encodePng(c.px, W, H)
}

export async function buildSetupScene(
  symbol: string,
  scene: Omit<SnapshotScene, 'symbol'>,
  kv?: VaneKv
): Promise<{ png: Uint8Array; scene: SnapshotScene } | null> {
  const full: SnapshotScene = { ...scene, symbol }
  const candles = await fetchKlinesCached(kv, symbol, 'Min15', 64)
  const png = await renderSetupChartPng(candles, full)
  if (!png) return null
  return { png, scene: full }
}

export async function inferEliteScene(
  symbol: string,
  kv: VaneKv | undefined,
  hint?: Partial<SnapshotScene>
): Promise<SnapshotScene | null> {
  const [c15, c1h, c4h, c1d] = await Promise.all([
    fetchKlinesCached(kv, symbol, 'Min15', 64),
    fetchKlinesCached(kv, symbol, 'Min60', 48),
    fetchKlinesCached(kv, symbol, 'Hour4', 90),
    fetchKlinesCached(kv, symbol, 'Day1', 40),
  ])
  const price = c15[c15.length - 1]?.[4] ?? hint?.entry ?? 0
  if (!(price > 0) || c4h.length < 20) return null
  const map = buildHtfLiquidityMap({
    candles4h: c4h,
    candles1d: c1d,
    candles1h: c1h,
    price,
  })
  const side = hint?.side ?? 'LONG'
  const zone =
    findSmartZone(side, price, map, price * 0.008, { relaxed: true }) ??
    findSmartZone(side === 'LONG' ? 'SHORT' : 'LONG', price, map, price * 0.008, {
      relaxed: true,
    })
  if (!zone && hint?.entry == null) return null
  const used = zone?.side ?? side
  const entry =
    hint?.entry && hint.entry > 0 ? hint.entry : zone?.limitEntry ?? price
  const target =
    hint?.target && hint.target > 0
      ? hint.target
      : zone?.target ??
        (used === 'LONG' ? price * 1.018 : price * 0.982)
  const magnet =
    used === 'LONG' ? map.nearestBSL : map.nearestSSL
  return {
    symbol,
    side: used,
    entry,
    target,
    zoneLow: hint?.zoneLow ?? zone?.zoneLow ?? entry * 0.994,
    zoneHigh: hint?.zoneHigh ?? zone?.zoneHigh ?? entry * 1.006,
    magnetPrice: hint?.magnetPrice ?? magnet?.price,
    magnetLabel: hint?.magnetLabel ?? 'MAGNET',
    caption: hint?.caption ?? '',
  }
}

export async function tgSendPhotoPng(opts: {
  token: string
  chatId: number
  png: Uint8Array
  caption: string
}): Promise<boolean> {
  const form = new FormData()
  form.append('chat_id', String(opts.chatId))
  form.append('caption', opts.caption.slice(0, 1024))
  form.append('parse_mode', 'HTML')
  form.append(
    'photo',
    new Blob([toArrayBuffer(opts.png)], { type: 'image/png' }),
    'elite-setup.png'
  )
  try {
    const res = await fetch(`https://api.telegram.org/bot${opts.token}/sendPhoto`, {
      method: 'POST',
      body: form,
    })
    if (res.ok) return true
    const fallback = new FormData()
    fallback.append('chat_id', String(opts.chatId))
    fallback.append('caption', opts.caption.slice(0, 1024))
    fallback.append(
      'document',
      new Blob([toArrayBuffer(opts.png)], { type: 'image/png' }),
      'elite-setup.png'
    )
    const doc = await fetch(
      `https://api.telegram.org/bot${opts.token}/sendDocument`,
      { method: 'POST', body: fallback }
    )
    return doc.ok
  } catch {
    return false
  }
}
