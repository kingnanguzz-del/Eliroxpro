const axios = require('axios');
const crypto = require('crypto');

/**
 * Authenticated Binance trading client. This is a DIFFERENT API surface
 * than the public market-data endpoints that got IP-banned earlier —
 * these calls are signed with your own API key/secret, so they're tied to
 * your account, not Render's shared IP reputation.
 *
 * SAFETY DEFAULT: testnet.binance.vision unless BINANCE_LIVE=true is
 * explicitly set. Testnet uses Binance's real matching engine and API
 * mechanics with fake funds — this is the correct way to validate
 * execution code before any real money is at risk.
 */
const isLive = process.env.BINANCE_LIVE === 'true';
const BASE_URL = isLive ? 'https://api.binance.com' : 'https://testnet.binance.vision';
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;

// Hard safety cap — even if something upstream miscalculates position size,
// no single order can exceed this dollar value. Override via env var only
// after you've genuinely thought about it.
const MAX_ORDER_USD = Number(process.env.MAX_LIVE_ORDER_USD || 20);

function sign(queryString) {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

async function signedRequest(method, path, params = {}) {
  if (!API_KEY || !API_SECRET) {
    throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET not set. Add them in Render → Environment.');
  }
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...params, timestamp, recvWindow: 5000 }).toString();
  const signature = sign(query);
  const url = `${BASE_URL}${path}?${query}&signature=${signature}`;

  const { data } = await axios({
    method,
    url,
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  return data;
}

async function getAccountBalance() {
  const account = await signedRequest('GET', '/api/v3/account');
  return account.balances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
}

/**
 * Places a market order. Hard-capped by MAX_ORDER_USD regardless of what
 * the caller requests — this is the last line of defense against a bug
 * upstream sizing a position too large.
 */
async function placeMarketOrder(symbol, side, quoteOrderQty) {
  const cappedQty = Math.min(quoteOrderQty, MAX_ORDER_USD);
  if (cappedQty < quoteOrderQty) {
    console.warn(`Order capped from $${quoteOrderQty} to $${cappedQty} by MAX_LIVE_ORDER_USD safety limit.`);
  }

  return signedRequest('POST', '/api/v3/order', {
    symbol: symbol.replace('/', ''),
    side, // 'BUY' or 'SELL'
    type: 'MARKET',
    quoteOrderQty: cappedQty.toFixed(2)
  });
}

async function getOpenOrders(symbol) {
  return signedRequest('GET', '/api/v3/openOrders', symbol ? { symbol: symbol.replace('/', '') } : {});
}

async function cancelOrder(symbol, orderId) {
  return signedRequest('DELETE', '/api/v3/order', { symbol: symbol.replace('/', ''), orderId });
}

module.exports = {
  getAccountBalance,
  placeMarketOrder,
  getOpenOrders,
  cancelOrder,
  isLive,
  MAX_ORDER_USD
};
