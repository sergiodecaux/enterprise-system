# Enterprise System

**Crypto probability terminal** - Real-time market analysis with AI-powered win probability signals.

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite
- **Styling**: TailwindCSS with custom sci-fi theme
- **State Management**: Zustand
- **Charts**: Lightweight Charts (TradingView)
- **WebSocket**: Binance Stream API
- **i18n**: i18next (English/Russian)
- **Deployment**: Vercel

## Setup Instructions

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd enterprise-system
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Generate system core data**
   ```bash
   cd scripts
   pip install -r requirements.txt
   python generate_core.py
   cd ..
   ```
   This generates `public/data/system_core.json` with probability lookup tables.

4. **Start development server**
   ```bash
   npm run dev
   ```

5. **Open in browser**
   - Navigate to `http://localhost:5173`
   - Or scan QR code from terminal

## Deployment

**Vercel (Recommended)**
1. Push code to GitHub
2. Connect repository to Vercel
3. Auto-deploys on every push
4. Set environment variables if needed

The app is configured as a Single Page Application (SPA) with proper routing.

## Telegram Bot Setup

1. **Create a Telegram Bot**
   - Message [@BotFather](https://t.me/botfather)
   - Use `/newbot` command
   - Save your bot token

2. **Set Mini App URL**
   - Use `/newapp` command in BotFather
   - Set URL to your Vercel deployment: `https://your-app.vercel.app`
   - Configure app settings (name, description, icon)

3. **Enable Payments** (for Pro features)
   - Use `/mybots` → Select your bot → Payments
   - Follow instructions to enable Telegram Stars payments

## Architecture

```
[Binance WS] → [Browser/Phone] → [RSI Calculator] → [JSON Lookup] → [UI]
                                          ↑
                              [system_core.json - Static File]
                                          ↑
                              [Python Generator - Offline]
```

**Data Flow:**
1. Binance WebSocket streams live ticker data
2. RSI Calculator processes prices client-side
3. Probability Engine looks up signals in pre-computed JSON
4. UI displays sorted signals with win probabilities
5. Python script (weekly) regenerates probability tables from historical data

## Project Structure

```
enterprise-system/
├── public/
│   └── data/
│       └── system_core.json          # Probability lookup table
├── src/
│   ├── components/
│   │   ├── layout/                  # Header, Status, Language
│   │   ├── radar/                   # Market radar view
│   │   ├── tactical/                # Detailed analysis drawer
│   │   └── monetization/            # Pro gate
│   ├── engine/                      # RSI Calculator, Probability Engine
│   ├── hooks/                       # WebSocket, Telegram, Data hooks
│   ├── store/                       # Zustand state management
│   ├── i18n/                        # Translations
│   └── styles/                      # Global CSS
├── scripts/
│   └── generate_core.py             # Data generator (runs weekly)
└── vercel.json                      # Deployment config
```

## Development

- **Dev server**: `npm run dev`
- **Build**: `npm run build`
- **Preview**: `npm run preview`
- **Lint**: `npm run lint`

## License

Proprietary - Enterprise System
