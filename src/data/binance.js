const axios = require('axios');

const BASE_URL = 'https://api.binance.com';

async function getCandles(symbol, interval = '15m', limit = 500) {
  const url = `${BASE_URL}/api/v3/klines`;
  const { data } = await axios.get(url, {
    params: { symbol: symbol.toUpperCase(), interval, limit }
  });

  return data.map(c => ({
    openTime: c[0],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
    closeTime: c[6]
  }));
}

async function getPrice(symbol) {
  const url = `${BASE_URL}/api/v3/ticker/price`;
  const { data } = await axios.get(url, { params: { symbol: symbol.toUpperCase() } });
  return parseFloat(data.price);
}

async function get24hStats(symbol) {
  const url = `${BASE_URL}/api/v3/ticker/24hr`;
  const { data } = await axios.get(url, { params: { symbol: symbol.toUpperCase() } });
  return {
    priceChangePercent: parseFloat(data.priceChangePercent),
    high: parseFloat(data.highPrice),
    low: parseFloat(data.lowPrice),
    volume: parseFloat(data.volume)
  };
}

module.exports = { getCandles, getPrice, get24hStats };
