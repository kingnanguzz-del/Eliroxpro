const express = require('express');
const router = express.Router();
const binance = require('../data/twelvedata');
const { scoreLatest } = require('../analytics/confluence');
const { runBacktest } = require('../backtest/engine');

// GET /api/signal?symbol=BTCUSDT&interval=15m
router.get('/signal', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = '15m' } = req.query;
    const candles = await binance.getCandles(symbol, interval, 200);
    const signal = scoreLatest(candles);
    const currentPrice = candles[candles.length - 1].close;
    res.json({ symbol, interval, currentPrice, ...signal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/backtest?symbol=BTCUSDT&interval=15m&limit=1000&entryThreshold=65&stopLossPct=1&takeProfitPct=2
router.get('/backtest', async (req, res) => {
  try {
    const {
      symbol = 'BTCUSDT',
      interval = '15m',
      limit = 1000,
      entryThreshold = 65,
      stopLossPct = 1.0,
      takeProfitPct = 2.0,
      maxHoldCandles = 20
    } = req.query;

    const candles = await binance.getCandles(symbol, interval, Math.min(Number(limit), 1000));
    const result = runBacktest(candles, {
      entryThreshold: Number(entryThreshold),
      stopLossPct: Number(stopLossPct),
      takeProfitPct: Number(takeProfitPct),
      maxHoldCandles: Number(maxHoldCandles)
    });
    res.json({ symbol, interval, candlesUsed: candles.length, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/price?symbol=BTCUSDT
router.get('/price', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT' } = req.query;
    const price = await binance.getPrice(symbol);
    const stats = await binance.get24hStats(symbol);
    res.json({ symbol, price, ...stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
