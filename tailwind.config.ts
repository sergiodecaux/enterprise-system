import type { Config } from 'tailwindcss'

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      screens: {
        desk: '1100px',
      },
      colors: {
        space: '#07090c',
        hull: '#0d1117',
        matrix: '#2ce08a',
        alert: '#ff5c73',
        holo: '#e8eef5',
        'hull-light': '#161c24',
        'hull-border': '#242c37',
        accent: '#5b9dff',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        panel: '0 1px 0 rgba(255,255,255,0.035) inset, 0 24px 48px -32px rgba(0,0,0,0.9)',
        glow: '0 0 0 1px rgba(44,224,138,0.25), 0 10px 30px -14px rgba(44,224,138,0.45)',
      },
    },
  },
  plugins: [],
} satisfies Config
