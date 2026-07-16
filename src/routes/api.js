const express = require('express');
const router = express.Router();
const binance = require('../data/twelvedata');
const { scoreLatest } = require('../analytics/confluence');
const { runBacktest } = require('../backtest/engine');
const { evaluateSymbol, scanSymbols } = require('../ml/trainEvaluate');
const { searchStrategies } = require('../strategy/searchStrategies');
const { createJob, updateProgress, completeJob, failJob, getJob } = require('../strategy/jobManager');
const { checkAndUpdate, checkMultiAgent } = require('../strategy/paperTradeLedger');
const { checkAndExecute } = require('../execution/liveTrader');
const { runStatArb } = require('../strategy/statArb');

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

// GET /api/ml-evaluate?symbol=BTC/USDT&interval=1h&candleCount=3000&horizon=5&targetPct=0.5
router.get('/ml-evaluate', async (req, res) => {
  try {
    const { symbol = 'BTC/USDT', interval = '1h', candleCount = 3000, horizon = 5, targetPct = 0.5, numFolds = 5 } = req.query;
    const result = await evaluateSymbol(symbol, interval, {
      candleCount: Number(candleCount),
      horizon: Number(horizon),
      targetPct: Number(targetPct),
      numFolds: Number(numFolds)
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ml-scan?symbols=BTC/USDT,ETH/USDT,EUR/USD,GBP/USD&interval=1h
router.get('/ml-scan', async (req, res) => {
  try {
    const { symbols = 'BTC/USDT,ETH/USDT,EUR/USD,GBP/USD,USD/JPY', interval = '1h', candleCount = 3000, horizon = 5, targetPct = 0.5, numFolds = 5 } = req.query;
    const symbolList = symbols.split(',').map(s => s.trim());
    const results = await scanSymbols(symbolList, interval, {
      candleCount: Number(candleCount),
      horizon: Number(horizon),
      targetPct: Number(targetPct),
      numFolds: Number(numFolds)
    });
    res.json({ interval, symbolsScanned: symbolList.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/strategy-search/start?symbol=BTC/USDT&interval=1h&candleCount=3000&useBulkHistory=true&yearsBack=5
// Runs ~1000 strategies in the background (can take a few minutes, longer
// with bulk history since it downloads real files on first run). Returns
// a jobId immediately instead of blocking — poll /strategy-search/:jobId.
router.post('/strategy-search/start', (req, res) => {
  const { symbol = 'BTC/USDT', interval = '1h', candleCount = 3000, useBulkHistory = 'false', yearsBack = 5 } = req.query;
  const jobId = createJob();

  searchStrategies(symbol, interval, {
    candleCount: Number(candleCount),
    useBulkHistory: useBulkHistory === 'true',
    yearsBack: Number(yearsBack),
    onProgress: (i, total, stage) => updateProgress(jobId, i, total)
  })
    .then(result => completeJob(jobId, result))
    .catch(err => failJob(jobId, err.message));

  res.json({ jobId, message: 'Search started. Poll GET /api/strategy-search/' + jobId + ' for progress.' });
});

// GET /api/strategy-search/:jobId
router.get('/strategy-search/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found (may have expired after 1 hour).' });
  res.json(job);
});

// POST /api/paper-trade/check?jobId=xxx&candidateIndex=0
// Manually triggers a live signal check + trade management for one of the
// job's top-2 paper-trade candidates. Call this whenever you open the app —
// it is NOT a 24/7 auto-trader on the free tier (see paperTradeLedger.js).
router.post('/paper-trade/check', async (req, res) => {
  try {
    const {
      jobId,
      candidateIndex = 0,
      startingCapital = 500,
      riskPerTradePct = 1.0,
      atrMultiplierForStop = 1.5,
      riskRewardRatio = 2.0,
      maxHoldCandles = 20
    } = req.query;
    const job = getJob(jobId);
    if (!job || job.status !== 'done') {
      return res.status(400).json({ error: 'Job not found or not finished yet.' });
    }
    const candidate = job.result.paperTrade2[Number(candidateIndex)];
    if (!candidate) {
      return res.status(400).json({ error: 'No paper-trade candidate at that index (may be fewer than 2 qualified).' });
    }
    const update = await checkAndUpdate(job.result.symbol, candidate, {
      startingCapital: Number(startingCapital),
      riskPerTradePct: Number(riskPerTradePct),
      atrMultiplierForStop: Number(atrMultiplierForStop),
      riskRewardRatio: Number(riskRewardRatio),
      maxHoldCandles: Number(maxHoldCandles)
    });
    res.json(update);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stat-arb?symbolA=BTC/USDT&symbolB=ETH/USDT&interval=1h&candleCount=1000
// Pairs trading: bets on the SPREAD reverting, not price direction. Gated by
// an ADF stationarity test — refuses to backtest pairs that aren't genuinely
// mean-reverting, since that's exactly how retail pairs trading fools itself.
router.get('/stat-arb', async (req, res) => {
  try {
    const {
      symbolA = 'BTC/USDT',
      symbolB = 'ETH/USDT',
      interval = '1h',
      candleCount = 1000,
      window = 50,
      entryZ = 2.0,
      exitZ = 0.5,
      maxHoldCandles = 30
    } = req.query;
    const result = await runStatArb(symbolA, symbolB, interval, {
      candleCount: Number(candleCount),
      window: Number(window),
      entryZ: Number(entryZ),
      exitZ: Number(exitZ),
      maxHoldCandles: Number(maxHoldCandles)
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/live-trade/check?jobId=xxx&candidateIndex=0&capital=100
// Same signal/risk logic as paper trading, but can place REAL orders on
// Binance testnet (default) or live (only if BINANCE_LIVE=true AND
// LIVE_TRADING_ENABLED=true are both set in Render's environment).
// Without LIVE_TRADING_ENABLED=true, this only reports what it WOULD do.
router.post('/live-trade/check', async (req, res) => {
  try {
    const { jobId, candidateIndex = 0, capital = 100 } = req.query;
    const job = getJob(jobId);
    if (!job || job.status !== 'done') {
      return res.status(400).json({ error: 'Job not found or not finished yet.' });
    }
    const candidate = job.result.paperTrade2[Number(candidateIndex)];
    if (!candidate) {
      return res.status(400).json({ error: 'No paper-trade candidate at that index.' });
    }
    const result = await checkAndExecute(job.result.symbol, candidate, { capital: Number(capital) });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/multi-agent/check?jobId=xxx
// The real "multi-agent" entrypoint: pools ALL validated candidates from a
// search (paperTrade2 + suggested8), detects the current market regime,
// and only activates whichever agent(s) actually have a track record in
// THIS regime — explicitly reporting which ones were skipped and why.
router.post('/multi-agent/check', async (req, res) => {
  try {
    const { jobId, startingCapital = 500, riskPerTradePct = 1.0 } = req.query;
    const job = getJob(jobId);
    if (!job || job.status !== 'done') {
      return res.status(400).json({ error: 'Job not found or not finished yet.' });
    }
    const agentPool = [...job.result.paperTrade2, ...job.result.suggested8];
    if (agentPool.length === 0) {
      return res.status(400).json({ error: 'No candidate agents in this search result.' });
    }
    const result = await checkMultiAgent(job.result.symbol, agentPool, {
      startingCapital: Number(startingCapital),
      riskPerTradePct: Number(riskPerTradePct)
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// GET /api/leaderboard - view all permanently-validated strategies across every search ever run
router.get('/leaderboard', (req, res) => {
  const { getTopStrategies } = require('../strategy/strategyLeaderboard');
  res.json({ topStrategies: getTopStrategies(20) });
});
