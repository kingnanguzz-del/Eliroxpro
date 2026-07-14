const axios = require('axios');

const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const BASE_URL = 'https://api-fxpractice.oanda.com'; // free demo/practice environment

/**
 * IMPORTANT — read before treating this like crypto L2:
 * This is NOT a true interbank order book. Forex has no single centralized
 * book (it's OTC across many banks/market makers) — this literally cannot
 * exist for free or paid. What OANDA provides instead is real: the
 * distribution of OANDA's OWN clients' pending orders and open positions
 * across price levels, refreshed every 15-30 minutes. It's a genuine,
 * free sentiment signal — just a different (and slower, and narrower)
 * thing than crypto L2. Treat it as retail positioning sentiment, not
 * liquidity depth.
 */
const OANDA_INSTRUMENT_MAP = {
  'EUR/USD': 'EUR_USD', 'GBP/USD': 'GBP_USD', 'USD/JPY': 'USD_JPY',
  'AUD/USD': 'AUD_USD', 'USD/CAD': 'USD_CAD', 'USD/CHF': 'USD_CHF',
  'NZD/USD': 'NZD_USD', 'EUR/GBP': 'EUR_GBP'
};

function toOandaInstrument(symbol) {
  return OANDA_INSTRUMENT_MAP[symbol.toUpperCase()] || null;
}

async function getPositionBook(symbol) {
  if (!API_KEY) {
    console.warn('OANDA_API_KEY not set — forex positioning disabled. Sign up free at oanda.com for a practice account.');
    return null;
  }
  const instrument = toOandaInstrument(symbol);
  if (!instrument) return null; // not a forex pair we have a mapping for

  try {
    const { data } = await axios.get(
      `${BASE_URL}/v3/instruments/${instrument}/positionBook`,
      { headers: { Authorization: `Bearer ${API_KEY}` }, timeout: 5000 }
    );
    const buckets = data.positionBook.buckets;
    const longVolume = buckets.reduce((sum, b) => sum + parseFloat(b.longCountPercent), 0);
    const shortVolume = buckets.reduce((sum, b) => sum + parseFloat(b.shortCountPercent), 0);
    const total = longVolume + shortVolume;

    return {
      // Positive = more OANDA clients net long; negative = net short.
      // Often read as a CONTRARIAN signal (retail crowding one way).
      imbalance: total > 0 ? +((longVolume - shortVolume) / total).toFixed(4) : 0,
      longPercent: +longVolume.toFixed(2),
      shortPercent: +shortVolume.toFixed(2),
      price: +data.positionBook.price,
      time: new Date(data.positionBook.time).getTime()
    };
  } catch (err) {
    console.warn('OANDA position book fetch failed for', symbol, ':', err.message);
    return null;
  }
}

module.exports = { getPositionBook, toOandaInstrument };
