// Vite provides import.meta.env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isDev = (import.meta as any).env?.DEV ?? import.meta.env?.MODE === 'development'

export const logger = {
  info: (...args: unknown[]) => isDev && console.log('🟢', ...args),
  warn: (...args: unknown[]) => isDev && console.warn('🟡', ...args),
  error: (...args: unknown[]) => console.error('🔴', ...args),
  ws: (...args: unknown[]) => isDev && console.log('📡', ...args),
}
