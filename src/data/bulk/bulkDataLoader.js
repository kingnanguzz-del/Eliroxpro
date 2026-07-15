const axios = require('axios');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

/**
 * Binance's public bulk data archive (data.binance.vision) — free, no API
 * key, no rate limits, direct file downloads. This is the actual fix for
 * the rate-limit/friction problems we kept hitting with live API polling:
 * instead of asking for data one request at a time, download whole months
 * of history as flat files, once, and cache them locally.
 *
 * Format: https://data.binance.vision/data/spot/monthly/klines/{SYMBOL}/{INTERVAL}/{SYMBOL}-{INTERVAL}-{YYYY-MM}.zip
 * Each zip contains one CSV: open_time,open,high,low,close,volume,close_time,...
 */
const BASE_URL = 'https://data.binance.vision/data/spot/monthly/klines';
const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'historical');

function toBinanceSymbol(symbol) {
  return symbol.toUpperCase().replace('/', '');
}

function cachePath(symbol, interval, yearMonth) {
  return path.join(CACHE_DIR, `${toBinanceSymbol(symbol)}_${interval}_${yearMonth}.json`);
}

/**
 * Downloads and parses ONE month of candles. Caches to disk so re-runs
 * (e.g. retraining later) don't re-download anything — this is what makes
 * "5 years of data" practical instead of a repeated multi-hour download.
 */
async function getMonth(symbol, interval, yearMonth) {
  const cached = cachePath(symbol, interval, yearMonth);
  if (fs.existsSync(cached)) {
    return JSON.parse(fs.readFileSync(cached, 'utf8'));
  }

  const binanceSymbol = toBinanceSymbol(symbol);
  const url = `${BASE_URL}/${binanceSymbol}/${interval}/${binanceSymbol}-${interval}-${yearMonth}.zip`;

  try {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    const zip = new AdmZip(Buffer.from(response.data));
    const entries = zip.getEntries();
    if (entries.length === 0) return [];

    const csvText = entries[0].getData().toString('utf8');
    const candles = csvText.trim().split('\n').filter(Boolean).map(line => {
      const cols = line.split(',');
      return {
        openTime: Number(cols[0]),
        open: parseFloat(cols[1]),
        high: parseFloat(cols[2]),
        low: parseFloat(cols[3]),
        close: parseFloat(cols[4]),
        volume: parseFloat(cols[5]),
        closeTime: Number(cols[6])
      };
    });

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cached, JSON.stringify(candles));
    return candles;
  } catch (err) {
    // Missing months (e.g. requesting before the pair existed, or the
    // current month which isn't archived yet) are normal — skip gracefully.
    console.warn(`No archive for ${binanceSymbol}/${interval}/${yearMonth}: ${err.message}`);
    return [];
  }
}

/**
 * Fetches multiple years of history by pulling each month in range and
 * concatenating. Downloads run sequentially and are cached, so a second
 * call (or a retrain later) for the same range is near-instant.
 */
async function getBulkHistory(symbol, interval, yearsBack = 5, onProgress = null) {
  const months = [];
  const now = new Date();
  for (let i = 0; i < yearsBack * 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i - 1, 1); // -1: skip current (unarchived) month
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  months.reverse(); // oldest first, so candles come back in chronological order

  let allCandles = [];
  for (let i = 0; i < months.length; i++) {
    const monthCandles = await getMonth(symbol, interval, months[i]);
    allCandles = allCandles.concat(monthCandles);
    if (onProgress) onProgress(i + 1, months.length);
  }

  return allCandles;
}

module.exports = { getBulkHistory, getMonth, toBinanceSymbol };
