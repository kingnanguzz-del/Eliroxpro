const axios = require('axios');

const BASE_URL = 'https://api.twelvedata.com';
const API_KEY = process.env.TWELVE_DATA_API_KEY;

// Twelve Data intervals differ slightly from Binance's naming
const INTERVAL_MAP = {
  '1m': '1min', '5m': '5min', '15m': '15min',
  '1h': '1h', '4h': '4h', '1d': '1day'
};

/**
 * Normalizes a symbol like "BTCUSDT" or "EURUSD" into Twelve Data's
 * required "BASE/QUOTE" format, e.g. "BTC/USDT", "EUR/USD".
 * If the user already typed it with a slash, leave it alone.
 */
function normalizeSymbol(raw) {
  const s = raw.toUpperCase().trim();
  if (s.includes('/')) return s;

  const quoteCandidates = ['USDT', 'USD', 'EUR', 'GBP', 'JPY', 'BTC', 'ETH'];
  for (const q of quoteCandidates) {
    if (s.endsWith(q) && s.length > q.length) {
      return `${s.slice(0, s.length - q.length)}/${q}`;
    }
  }
  // fallback: assume last 3 chars are quote currency
  return `${s.slice(0, -3)}/${s.slice(-3)}`;
}

async function getCandles(symbol, interval = '15m', limit = 500) {
  if (!API_KEY) {
    throw new Error('TWELVE_DATA_API_KEY is not set. Add it in Render → Environment.');
  }
  const tdInterval = INTERVAL_MAP[interval] || interval;
  const tdSymbol = normalizeSymbol(symbol);

  let data;
  try {
    const response = await axios.get(`${BASE_URL}/time_series`, {
      params: {
        symbol: tdSymbol,
        interval: tdInterval,
        outputsize: Math.min(limit, 5000),
        apikey: API_KEY,
        order: 'ASC'
      }
    });
    data = response.data;
  } catch (err) {
    // Twelve Data sometimes returns an actual HTTP error status (400/404/429)
    // instead of a 200 with {status:'error'} — axios's default message hides
    // the real reason ("Request failed with status code 404" tells you
    // nothing). Surface whatever Twelve Data actually said instead.
    const apiMessage = err.response?.data?.message || err.response?.data?.code || null;
    const status = err.response?.status;
    if (status === 429) {
      throw new Error(`Twelve Data rate limit hit (429) for ${tdSymbol}/${tdInterval} — free tier allows 8 requests/min, 800/day. Wait a minute and retry, or reduce how many symbols/intervals you're checking at once.`);
    }
    throw new Error(`Twelve Data request failed for ${tdSymbol}/${tdInterval} (HTTP ${status || 'unknown'})${apiMessage ? ': ' + apiMessage : ' — no further detail returned.'}`);
  }

  if (data.status === 'error') {
    throw new Error(`Twelve Data error for ${tdSymbol}/${tdInterval}: ${data.message}`);
  }
  if (!data.values) {
    throw new Error(`No candle data returned for ${tdSymbol}/${tdInterval} — check symbol format (e.g. BTC/USDT, EUR/USD) or that this pair exists on Twelve Data's free tier.`);
  }

  return data.values.map(v => ({
    openTime: new Date(v.datetime).getTime(),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: v.volume ? parseFloat(v.volume) : 0,
    closeTime: new Date(v.datetime).getTime()
  }));
}

async function getPrice(symbol) {
  const candles = await getCandles(symbol, '1m', 1);
  return candles[candles.length - 1].close;
}

/**
 * Computed from candle history rather than a separate endpoint —
 * keeps us to one API call per request (Twelve Data free tier: 800/day, 8/min).
 */
async function get24hStats(symbol, interval = '1h') {
  const candles = await getCandles(symbol, interval, 24);
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const first = closes[0];
  const last = closes[closes.length - 1];
  return {
    priceChangePercent: (((last - first) / first) * 100),
    high: Math.max(...highs),
    low: Math.min(...lows),
    volume: candles.reduce((a, c) => a + c.volume, 0)
  };
}

module.exports = { getCandles, getPrice, get24hStats, normalizeSymbol };
