import type { Config } from 'tailwindcss'

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        space: '#0a0a0a',
        hull: '#111111',
        matrix: '#00ff41',
        alert: '#ff003c',
        holo: '#e0e0e0',
        'hull-light': '#1a1a1a',
        'hull-border': '#2a2a2a',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config
