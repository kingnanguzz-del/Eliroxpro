# EliroxPro — Phase 1

Transparent trading analytics: signal generation + backtesting, built to be more
explainable than Elirox's "AI Preset" black box. Every signal shows exactly
which indicators fired and why.

## What's in Phase 1

- **Live signal scoring** (`/api/signal`) — RSI, MACD, CCI, EMA trend filter,
  ATR volatility regime, combined into a transparent 0–100 confluence score
- **Backtesting engine** (`/api/backtest`) — walk-forward simulation (no
  lookahead bias) reporting win rate, expectancy, drawdown — the validation
  step Elirox's users complain about not having
- **Mobile dashboard** (`public/index.html`) — check signals and run
  backtests from your phone browser
- **Twelve Data source** — free API key, no shared-IP ban risk (see setup below)

## Not yet built (phase 2+)

- Live automated execution (placing real orders)
- ML pattern/trend detection layer
- Broker integration beyond Binance (MT4/MT5/Exness)
- User accounts / multi-strategy management

## Why Twelve Data instead of Binance

Binance bans requests by IP address, not by API key. Render's free tier shares
outbound IPs across many different customers' apps — so it's common to
inherit a ban (HTTP 418) caused by someone else's app on the same shared IP,
even on your very first request. Twelve Data rate-limits by API key instead,
so this doesn't happen.

## Get a free Twelve Data API key (2 minutes, phone-friendly)

1. Go to twelvedata.com in your phone browser
2. Tap "Get free API key" / Sign up (email is enough, no card needed)
3. Once logged in, your dashboard shows an API key — copy it
4. Free tier: 800 requests/day, 8 requests/minute — plenty for personal signal
   checking and backtesting

## Add the key to Render

1. Open your Render dashboard → your `eliroxpro` service
2. Go to the **Environment** tab
3. Tap **Add Environment Variable**
4. Key: `TWELVE_DATA_API_KEY`
5. Value: paste your key
6. Save — Render will automatically redeploy with the new variable

## Deploying from your phone (Render + GitHub, same as knanGuz)

1. **Push to GitHub**
   - Open the GitHub app (or github.com in your phone browser)
   - Create a new repo, e.g. `eliroxpro`
   - Use GitHub's "upload files" web UI to upload this whole folder, OR if
     you have Termux/a code editor app, `git init && git add . && git commit
     -m "phase 1" && git push`

2. **Deploy on Render**
   - Go to render.com → New → Web Service
   - Connect your GitHub repo
   - Build command: `npm install`
   - Start command: `npm start`
   - Render auto-detects the `PORT` env var, no changes needed

3. **Test it**
   - Visit `https://your-app.onrender.com` — dashboard loads
   - Try symbol `BTCUSDT`, interval `15m`, tap "Get Signal"
   - Tap "Run Backtest" to validate the strategy on the last 1000 candles

## API reference

```
GET /api/signal?symbol=BTCUSDT&interval=15m
GET /api/backtest?symbol=BTCUSDT&interval=15m&entryThreshold=65&stopLossPct=1&takeProfitPct=2&maxHoldCandles=20
GET /api/price?symbol=BTCUSDT
```

Supported intervals: 1m, 5m, 15m, 1h, 4h, 1d (any Binance kline interval)
Supported symbols: any Binance pair, e.g. BTCUSDT, ETHUSDT, SOLUSDT

## Important — before you trust any signal with real money

- Backtest every strategy config on at least 1000+ candles before trusting it
- Win rate alone means nothing — check expectancy and max drawdown together
- A backtest on historical data is not a guarantee of future performance;
  markets change regime
- Start on Binance testnet or paper-trade manually before wiring up live
  execution in phase 2
