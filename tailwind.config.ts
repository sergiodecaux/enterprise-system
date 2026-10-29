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
        // ── Graphite surfaces ──────────────────────────────────────────
        bg: {
          base: '#0B0E13',
          panel: '#11151C',
          elevated: '#171C24',
          surface: '#1F2633',
        },
        border: {
          subtle: 'rgba(255, 255, 255, 0.06)',
          DEFAULT: '#232A35',
          active: '#3A4454',
        },

        // ── Market semantics ───────────────────────────────────────────
        market: {
          long: '#2DD4BF',
          short: '#FB7185',
          warning: '#F5B942',
          info: '#6EA8FE',
          purple: '#A78BFA',
        },

        // ── Brand: navigation, LIVE, master CTA only ──────────────────
        brand: {
          DEFAULT: '#35E0A1',
          hover: '#29C98E',
          active: 'rgba(53, 224, 161, 0.14)',
        },

        // ── Text ───────────────────────────────────────────────────────
        text: {
          primary: '#E8EDF4',
          secondary: '#94A0B2',
          muted: '#5F6B7C',
          disabled: '#3D4654',
        },

        // ── Legacy aliases ─────────────────────────────────────────────
        // Kept so the existing ~107 screens inherit the new system before
        // they are migrated to the semantic tokens above.
        space: '#0B0E13',
        hull: '#11151C',
        'hull-light': '#171C24',
        'hull-border': '#232A35',
        matrix: '#35E0A1',
        alert: '#FB7185',
        holo: '#E8EDF4',
        accent: '#6EA8FE',
        long: '#2DD4BF',
        short: '#FB7185',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        display: ['24px', { lineHeight: '30px', fontWeight: '600' }],
        title: ['18px', { lineHeight: '24px', fontWeight: '500' }],
        body: ['13px', { lineHeight: '18px' }],
        secondary: ['12px', { lineHeight: '16px' }],
        micro: ['11px', { lineHeight: '14px', fontWeight: '500' }],
        'num-lg': ['18px', { lineHeight: '22px', fontWeight: '500' }],
        'num-base': ['13px', { lineHeight: '16px' }],
        'num-sm': ['11px', { lineHeight: '14px' }],
      },
      borderRadius: {
        sm: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
      },
      boxShadow: {
        panel:
          '0 1px 0 rgba(255,255,255,0.03) inset, 0 18px 40px -32px rgba(0,0,0,0.9)',
        glow:
          '0 0 0 1px rgba(53,224,161,0.18), 0 10px 28px -18px rgba(53,224,161,0.35)',
        modal: '0 16px 36px -8px rgba(0,0,0,0.75), 0 0 0 1px #232A35',
        popover: '0 8px 24px -4px rgba(0,0,0,0.6), 0 0 0 1px #232A35',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
} satisfies Config
