const axios = require('axios');

/**
 * Kraken Futures historical funding rates — public endpoint, no API key.
 * Funding rate is the periodic payment between longs and shorts on a
 * perpetual future; persistently positive/negative rates reflect real
 * structural sentiment (who's paying whom to hold their position), which
 * is different information than price action alone.
 */
const FUTURES_SYMBOL_MAP = {
  'BTC/USDT': 'PF_XBTUSD', 'BTC/USD': 'PF_XBTUSD',
  'ETH/USDT': 'PF_ETHUSD', 'ETH/USD': 'PF_ETHUSD',
  'SOL/USDT': 'PF_SOLUSD', 'SOL/USD': 'PF_SOLUSD'
};

function toFuturesSymbol(symbol) {
  return FUTURES_SYMBOL_MAP[symbol.toUpperCase()] || null;
}

/**
 * Returns recent funding rate history, or null if unavailable (e.g. no
 * perpetual future exists for this symbol — forex pairs, for instance).
 * Caller must handle null gracefully, same pattern as the news calendar.
 */
async function getFundingRateHistory(symbol) {
  const futuresSymbol = toFuturesSymbol(symbol);
  if (!futuresSymbol) return null;

  try {
    const { data } = await axios.get('https://futures.kraken.com/derivatives/api/v3/historical-funding-rates', {
      params: { symbol: futuresSymbol },
      timeout: 5000
    });
    if (data.result !== 'success' || !data.rates) return null;

    return data.rates.map(r => ({
      time: new Date(r.timestamp).getTime(),
      fundingRate: r.relativeFundingRate
    }));
  } catch (err) {
    console.warn('Funding rate fetch failed for', symbol, ':', err.message);
    return null;
  }
}

/**
 * Returns the funding rate closest to (at or before) a given timestamp —
 * used to attach a funding-rate feature to each historical candle.
 */
function findRateAtTime(rateHistory, timestamp) {
  if (!rateHistory || rateHistory.length === 0) return null;
  let closest = null;
  for (const r of rateHistory) {
    if (r.time <= timestamp) closest = r;
    else break;
  }
  return closest ? closest.fundingRate : null;
}

module.exports = { getFundingRateHistory, findRateAtTime, toFuturesSymbol };
