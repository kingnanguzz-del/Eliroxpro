const axios = require('axios');

/**
 * Kraken's public market data needs NO API key — this is the one real,
 * free L2 order book source available without a paid provider like
 * Tardis.dev or CoinAPI. Separate provider from Binance/Twelve Data too,
 * so it doesn't share their rate-limit or IP-ban history.
 *
 * Kraken uses its own pair naming (e.g. XBTUSD not BTCUSD) — mapping
 * common symbols below; extend as needed.
 */
const KRAKEN_PAIR_MAP = {
  'BTC/USDT': 'XBTUSDT', 'BTC/USD': 'XBTUSD',
  'ETH/USDT': 'ETHUSDT', 'ETH/USD': 'ETHUSD',
  'SOL/USDT': 'SOLUSDT', 'SOL/USD': 'SOLUSD'
};

function toKrakenPair(symbol) {
  return KRAKEN_PAIR_MAP[symbol.toUpperCase()] || symbol.replace('/', '').toUpperCase();
}

/**
 * Returns order book imbalance: (bidVolume - askVolume) / (bidVolume + askVolume)
 * across the top `depth` levels. Range -1 (all asks, selling pressure) to
 * +1 (all bids, buying pressure). This is real market-microstructure
 * information — not derivable from OHLC candles alone.
 */
async function getOrderBookImbalance(symbol, depth = 20) {
  const pair = toKrakenPair(symbol);
  try {
    const { data } = await axios.get('https://api.kraken.com/0/public/Depth', {
      params: { pair, count: depth },
      timeout: 5000
    });
    if (data.error && data.error.length > 0) {
      throw new Error(data.error.join(', '));
    }
    const resultKey = Object.keys(data.result)[0];
    const book = data.result[resultKey];

    const bidVolume = book.bids.reduce((sum, [price, vol]) => sum + parseFloat(vol), 0);
    const askVolume = book.asks.reduce((sum, [price, vol]) => sum + parseFloat(vol), 0);
    const totalVolume = bidVolume + askVolume;
    const imbalance = totalVolume > 0 ? (bidVolume - askVolume) / totalVolume : 0;

    return {
      imbalance: +imbalance.toFixed(4),
      bidVolume: +bidVolume.toFixed(4),
      askVolume: +askVolume.toFixed(4),
      bestBid: +book.bids[0][0],
      bestAsk: +book.asks[0][0],
      spread: +(book.asks[0][0] - book.bids[0][0]).toFixed(4)
    };
  } catch (err) {
    console.warn('Order book fetch failed for', symbol, ':', err.message);
    return null; // caller should treat this feature as unavailable, not crash
  }
}

module.exports = { getOrderBookImbalance, toKrakenPair };
