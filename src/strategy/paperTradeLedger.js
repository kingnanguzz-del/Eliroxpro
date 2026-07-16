const { LogisticRegression } = require('../ml/logisticRegression');
const { NeuralNet } = require('../ml/neuralNet');
const { buildDataset } = require('../ml/features');
const marketData = require('../data/twelvedata');
const { getHighImpactEvents, flagCandlesNearEvents } = require('../data/economicCalendar');
const { getCarryDifferential } = require('../data/carry');
const { getFundingRateHistory } = require('../data/fundingRate');
const { getOrderBookImbalance } = require('../data/orderbook');
const { getPositionBook, toOandaInstrument } = require('../data/oandaPositioning');
const { logSnapshot, getMemoryStats } = require('./memoryStore');
const { calculatePositionSize } = require('./riskManagement');
const { incrementalUpdate, computeTrustMultiplier } = require('../ml/onlineLearning');
const persistentStore = require('../data/persistentStore');
const { classifyRegimes } = require('./regimeDetection');
const { selectAppropriateAgents } = require('./agentCoordinator');
const { analyzeLossPatterns, matchesKnownLossPattern } = require('./lossPatternAnalysis');

/**
 * Returns the model state to actually use: a persisted, incrementally-
 * updated version if one exists from past real trade outcomes, otherwise
 * the original snapshot from when the strategy search first found it.
 * This is what makes online learning "stick" across checks — the in-memory
 * job store expires after an hour, but this doesn't.
 */
function getEffectiveSerializedModel(symbol, strategyId, originalSerializedModel) {
  const persisted = persistentStore.get(`model_${symbol}_${strategyId}`);
  return persisted || originalSerializedModel;
}

/**
 * In-memory paper-trade ledger. Honest limitation: Render's free tier spins
 * down when idle, so this is NOT a reliable 24/7 auto-trader — it only
 * updates when someone (you, opening the app) triggers a check. A true
 * always-on paper trader needs a paid always-on instance or an external
 * cron service pinging this endpoint on a schedule. This is real, working
 * paper trading — just not autonomous while your phone/browser is closed.
 */
const ledger = new Map(); // key: `${symbol}_${strategyId}` -> { openTrade, closedTrades, config }
const vetoLedger = new Map(); // key: `${symbol}_${strategyId}` -> { pending: [], resolved: [] }

/**
 * Resolves past vetoes whose outcome window has elapsed: did price actually
 * move favorably (veto was wrong — a real trade got skipped for nothing) or
 * unfavorably (veto was right — it protected capital)? This is what lets
 * the bot learn from its own caution instead of repeating it blindly.
 */
function resolveVetoes(key, currentPrice, currentTime, strategy) {
  const entry = vetoLedger.get(key);
  if (!entry) return;
  const horizonMs = 3600000 * strategy.horizon; // approx, assumes 1h candles

  const stillPending = [];
  for (const v of entry.pending) {
    if (currentTime - v.vetoedAt < horizonMs) { stillPending.push(v); continue; }
    const movePct = ((currentPrice - v.priceAtVeto) / v.priceAtVeto) * 100;
    const wouldHaveWon = movePct >= strategy.targetPct;
    entry.resolved.push({ ...v, movePct: +movePct.toFixed(2), wouldHaveWon });
  }
  entry.pending = stillPending;
}

function getVetoRegretRate(key) {
  const entry = vetoLedger.get(key);
  if (!entry || entry.resolved.length < 10) {
    return { available: false, sampleSize: entry ? entry.resolved.length : 0 };
  }
  const wins = entry.resolved.filter(v => v.wouldHaveWon).length;
  const regretRate = wins / entry.resolved.length;
  return {
    available: true,
    sampleSize: entry.resolved.length,
    regretRate: +(regretRate * 100).toFixed(1),
    // If vetoing has been wrong most of the time, the caution itself has a
    // track record of costing money — worth taking a SMALL, tightly-stopped
    // trade instead of a full skip, not reversing the caution entirely.
    shouldTryCautiousTrade: regretRate >= 0.6
  };
}

function recordVeto(key, priceAtVeto, vetoedAt) {
  if (!vetoLedger.has(key)) vetoLedger.set(key, { pending: [], resolved: [] });
  vetoLedger.get(key).pending.push({ priceAtVeto, vetoedAt });
}

function reconstructModel(serializedModel) {
  if (serializedModel.modelType === 'neural') {
    const net = new NeuralNet(1, serializedModel.hiddenSize); // numFeatures unused post-construction
    net.W1 = serializedModel.W1;
    net.b1 = serializedModel.b1;
    net.W2 = serializedModel.W2;
    net.b2 = serializedModel.b2;
    return net;
  }
  const model = new LogisticRegression(serializedModel.weights.length);
  model.weights = serializedModel.weights;
  model.bias = serializedModel.bias;
  return model;
}

/**
 * Fetches live data and computes the current model signal for one strategy,
 * with no position management — just "what does this model say right now."
 * Reused by both the single-strategy checker and the portfolio manager.
 */
async function getLiveSignal(symbol, strategyResult) {
  const { strategy, serializedModel } = strategyResult;

  const candles = await marketData.getCandles(symbol, '1h', 300);
  const events = await getHighImpactEvents(
    new Date(candles[0].closeTime).toISOString().slice(0, 10),
    new Date(candles[candles.length - 1].closeTime).toISOString().slice(0, 10)
  );
  const newsFlags = flagCandlesNearEvents(candles, events, 60);
  const carryDifferential = getCarryDifferential(symbol);
  const fundingRateHistory = await getFundingRateHistory(symbol);

  const dataset = buildDataset(candles, {
    horizon: strategy.horizon,
    targetPct: strategy.targetPct,
    newsFlags,
    carryDifferential,
    fundingRateHistory
  });
  if (dataset.length === 0) return null;

  const latestRow = dataset[dataset.length - 1];
  const effectiveModel = getEffectiveSerializedModel(symbol, strategyResult.strategyId, serializedModel);
  const model = reconstructModel(effectiveModel);
  const proba = model.predictProba(latestRow.features);

  // Order book imbalance is LIVE-ONLY (no free historical L2 archive exists
  // to train on) — used here as an independent confirmation check, never
  // fed into the trained model, so there's no train/serve mismatch.
  // Crypto uses real Kraken L2; forex uses OANDA's client positioning
  // (the closest free substitute, since forex has no centralized L2 at all).
  const isForexPair = toOandaInstrument(symbol) != null;

  let orderBook = null;
  let sourceType = null;
  if (isForexPair) {
    orderBook = await getPositionBook(symbol);
    sourceType = 'forex_positioning';
  } else {
    orderBook = await getOrderBookImbalance(symbol, 20);
    sourceType = 'crypto_orderbook';
  }

  // Build our own history — no free archive exists anywhere for this data,
  // so we start one now. This is what makes the bot's use of this data a
  // genuine memory of the past instead of a single noisy snapshot.
  if (orderBook) {
    logSnapshot(symbol, sourceType, { imbalance: orderBook.imbalance });
  }
  const memory = getMemoryStats(symbol, sourceType);

  return {
    proba,
    signal: proba >= strategy.decisionThreshold ? 'long' : 'no_trade',
    currentPrice: candles[candles.length - 1].close,
    now: candles[candles.length - 1].closeTime,
    candleDurationMs: candles[candles.length - 1].closeTime - candles[candles.length - 2].closeTime || 3600000,
    candles,
    orderBook,
    memory,
    isForexPair,
    entryFeatures: latestRow.features
  };
}

/**
 * Fetches live data and computes the current signal from a saved model, and
 * manages one open paper trade per strategy against a real capital account:
 * position size is derived from account capital and current volatility
 * (ATR), not a fixed guess. Risk per trade is a % of CURRENT capital, so the
 * account compounds (and shrinks) realistically as trades close.
 */
async function checkAndUpdate(symbol, strategyResult, opts = {}) {
  const {
    riskPerTradePct = 1.0,       // % of current capital risked per trade
    atrMultiplierForStop = 1.5,  // stop distance = ATR * this
    riskRewardRatio = 2.0,       // take-profit distance = stop distance * this
    maxHoldCandles = 20,
    maxPositionPctOfCapital = 50
  } = opts;
  const key = `${symbol}_${strategyResult.strategyId}`;

  if (!ledger.has(key)) {
    const startingCapital = opts.startingCapital || 500;
    ledger.set(key, {
      openTrade: null,
      closedTrades: [],
      config: strategyResult.strategy,
      capital: startingCapital,
      startingCapital,
      equityCurve: [{ time: Date.now(), capital: startingCapital }]
    });
  }
  const entry = ledger.get(key);

  const live = await getLiveSignal(symbol, strategyResult);
  if (!live) return entry;
  const { proba, signal, currentPrice, now, candleDurationMs, candles, orderBook, memory, isForexPair, entryFeatures } = live;

  // Live order book confirmation: if the model says "long" but the order
  // book shows heavy real-time selling pressure, that's a genuine conflict
  // worth respecting — skip the entry rather than overriding live market
  // structure with a model trained only on historical OHLC.
  const orderBookVetoThreshold = -0.2;
  const currentSnapshotConflicts = orderBook && orderBook.imbalance < orderBookVetoThreshold;
  const memoryTrendConflicts = memory && memory.available && memory.trendDirection === 'building_sell_pressure';
  const orderBookConflicts = currentSnapshotConflicts || memoryTrendConflicts;

  // Resolve any past vetoes whose outcome window has now elapsed, and check
  // whether this veto pattern has a track record of being wrong.
  resolveVetoes(key, currentPrice, now, strategyResult.strategy);
  const vetoTrack = getVetoRegretRate(key);

  if (entry.openTrade) {
    const heldCandles = (now - entry.openTrade.openedAt) / candleDurationMs;
    const changePct = ((currentPrice - entry.openTrade.entryPrice) / entry.openTrade.entryPrice) * 100;
    const hitTP = currentPrice >= entry.openTrade.takeProfitPrice;
    const hitSL = currentPrice <= entry.openTrade.stopLossPrice;
    const timedOut = heldCandles >= maxHoldCandles;

    if (hitTP || hitSL || timedOut) {
      // P&L in real dollars based on the actual position size opened, not a
      // flat percentage — this is what makes it capital-aware.
      const pnlDollars = entry.openTrade.positionSizeUnits * (currentPrice - entry.openTrade.entryPrice);
      entry.capital = +(entry.capital + pnlDollars).toFixed(2);
      entry.equityCurve.push({ time: now, capital: entry.capital });

      const closedRecord = {
        ...entry.openTrade,
        exitPrice: currentPrice,
        exitTime: now,
        pnlDollars: +pnlDollars.toFixed(2),
        pnlPct: +changePct.toFixed(2),
        capitalAfter: entry.capital,
        outcome: hitTP ? 'take_profit' : hitSL ? 'stop_loss' : 'timeout'
      };
      entry.closedTrades.push(closedRecord);

      // ONLINE LEARNING: nudge the model's actual weights using this real
      // outcome — not a full retrain, a small dampened update on top of
      // everything it already learned (see onlineLearning.js). Persisted
      // so it survives past this session, unlike the in-memory ledger.
      if (entry.openTrade.entryFeatures) {
        const actualLabel = closedRecord.pnlPct > 0 ? 1 : 0;
        const modelKey = `model_${symbol}_${strategyResult.strategyId}`;
        const currentSerialized = getEffectiveSerializedModel(symbol, strategyResult.strategyId, strategyResult.serializedModel);
        const modelToUpdate = reconstructModel(currentSerialized);
        incrementalUpdate(modelToUpdate, entry.openTrade.entryFeatures, actualLabel);

        const updatedSerialized = strategyResult.strategy.modelType === 'neural'
          ? { modelType: 'neural', W1: modelToUpdate.W1, b1: modelToUpdate.b1, W2: modelToUpdate.W2, b2: modelToUpdate.b2, hiddenSize: strategyResult.strategy.hiddenSize }
          : { modelType: 'logistic', weights: modelToUpdate.weights, bias: modelToUpdate.bias };
        persistentStore.set(modelKey, updatedSerialized);
      }

      // Log this outcome permanently — this is the "remembering patterns"
      // dataset that the trust multiplier and future analysis draw from.
      // Tagging with regime lets the coordinator later ask "did this
      // strategy actually work in trending markets specifically," not
      // just "did it work on average."
      const regimesAtClose = classifyRegimes(candles);
      const regimeLabel = regimesAtClose[regimesAtClose.length - 1] || null;
      persistentStore.appendLog(`trades_${symbol}_${strategyResult.strategyId}`, {
        pnlPct: closedRecord.pnlPct,
        pnlDollars: closedRecord.pnlDollars,
        outcome: closedRecord.outcome,
        wasCautiousOverride: !!entry.openTrade.wasCautiousOverride,
        regimeLabel
      });

      entry.openTrade = null;
    }
  } else if (signal === 'long' && orderBookConflicts) {
    // The model wants in, but the order book conflicts. Normally this is a
    // full skip. But if this exact veto pattern has been WRONG most of the
    // time (tracked via vetoTrack), take a small, tightly-stopped trade
    // instead of blindly repeating a caution with a bad track record —
    // this is a cautious probe, not a reversal of the caution itself.
    if (vetoTrack.available && vetoTrack.shouldTryCautiousTrade) {
      const trust = computeTrustMultiplier(persistentStore.getLog(`trades_${symbol}_${strategyResult.strategyId}`));
      const sizing = calculatePositionSize(candles, {
        capital: entry.capital,
        riskPerTradePct: riskPerTradePct * 0.25 * trust.multiplier, // quarter-size — cautious, not confident
        atrMultiplierForStop: atrMultiplierForStop * 0.6, // tighter stop, closes fast if wrong
        maxPositionPctOfCapital
      });
      if (!sizing.error) {
        const takeProfitPrice = currentPrice + (currentPrice - sizing.stopLossPrice) * riskRewardRatio;
        entry.openTrade = {
          entryPrice: currentPrice,
          openedAt: now,
          signalProbability: +proba.toFixed(3),
          positionSizeUnits: sizing.positionSizeUnits,
          positionSizeDollars: sizing.positionSizeDollars,
          stopLossPrice: sizing.stopLossPrice,
          takeProfitPrice: +takeProfitPrice.toFixed(4),
          riskAmountDollars: sizing.riskAmountDollars,
          riskPctOfCapital: sizing.riskPctOfCapital,
          capitalAtEntry: entry.capital,
          wasCautiousOverride: true,
          entryFeatures
        };
      }
    } else {
      recordVeto(key, currentPrice, now);
    }
  } else if (signal === 'long' && !orderBookConflicts) {
    // Check the current setup against this strategy's own real past losses
    // — the honest "learn from mistakes" mechanism: not a promise to avoid
    // all losses, but a concrete refusal to repeat a specific, evidenced
    // bad pattern.
    const lossAnalysis = analyzeLossPatterns(symbol, strategyResult.strategyId);
    const lossMatch = matchesKnownLossPattern(entryFeatures, lossAnalysis);

    if (lossMatch.matches) {
      recordVeto(key, currentPrice, now);
    } else {
      const trust = computeTrustMultiplier(persistentStore.getLog(`trades_${symbol}_${strategyResult.strategyId}`));
      const sizing = calculatePositionSize(candles, {
        capital: entry.capital,
        riskPerTradePct: riskPerTradePct * trust.multiplier,
        atrMultiplierForStop,
        maxPositionPctOfCapital
      });

      if (!sizing.error) {
        const takeProfitPrice = currentPrice + (currentPrice - sizing.stopLossPrice) * riskRewardRatio;
        entry.openTrade = {
          entryPrice: currentPrice,
          openedAt: now,
          signalProbability: +proba.toFixed(3),
          positionSizeUnits: sizing.positionSizeUnits,
          positionSizeDollars: sizing.positionSizeDollars,
          stopLossPrice: sizing.stopLossPrice,
          takeProfitPrice: +takeProfitPrice.toFixed(4),
          riskAmountDollars: sizing.riskAmountDollars,
          riskPctOfCapital: sizing.riskPctOfCapital,
          capitalAtEntry: entry.capital,
          entryFeatures
        };
      }
    }
  }

  const tradeLog = persistentStore.getLog(`trades_${symbol}_${strategyResult.strategyId}`);
  const trust = computeTrustMultiplier(tradeLog);
  const hasLearnedModel = persistentStore.get(`model_${symbol}_${strategyResult.strategyId}`) != null;

  return {
    symbol,
    strategyId: strategyResult.strategyId,
    currentSignal: signal,
    signalProbability: +proba.toFixed(3),
    currentPrice,
    orderBook: orderBook ? { imbalance: orderBook.imbalance } : null,
    dataSourceType: isForexPair ? 'forex_positioning (OANDA client sentiment)' : 'crypto_orderbook (real Kraken L2)',
    memory,
    orderBookVetoedEntry: signal === 'long' && orderBookConflicts && !(entry.openTrade && entry.openTrade.wasCautiousOverride),
    vetoTrack,
    learning: {
      usingLearnedModel: hasLearnedModel,
      realTradesLogged: tradeLog.length,
      trustMultiplier: trust.multiplier,
      trustReason: trust.reason,
      lossPatterns: analyzeLossPatterns(symbol, strategyResult.strategyId)
    },
    capital: entry.capital,
    startingCapital: entry.startingCapital,
    totalReturnPct: +(((entry.capital - entry.startingCapital) / entry.startingCapital) * 100).toFixed(2),
    openTrade: entry.openTrade,
    closedTrades: entry.closedTrades,
    summary: summarizeLedger(entry.closedTrades, entry.startingCapital, entry.capital)
  };
}

function summarizeLedger(closedTrades, startingCapital, currentCapital) {
  if (closedTrades.length === 0) {
    return { totalTrades: 0, winRate: null, totalReturnPct: 0, totalPnlDollars: 0 };
  }
  const wins = closedTrades.filter(t => t.pnlDollars > 0);
  const totalPnlDollars = closedTrades.reduce((a, t) => a + t.pnlDollars, 0);
  return {
    totalTrades: closedTrades.length,
    winRate: +((wins.length / closedTrades.length) * 100).toFixed(1),
    totalPnlDollars: +totalPnlDollars.toFixed(2),
    totalReturnPct: +(((currentCapital - startingCapital) / startingCapital) * 100).toFixed(2)
  };
}

/**
 * The actual "multi-agent" entrypoint: given a pool of candidate agents
 * (e.g. paperTrade2 + suggested8 from a strategy search), figures out the
 * current market regime once, asks the coordinator which agent(s) actually
 * have standing to act right now, and only runs the full check/trade logic
 * for those — the rest are reported as explicitly skipped, with reasons,
 * not silently ignored.
 */
async function checkMultiAgent(symbol, agentPool, opts = {}) {
  const candles = await marketData.getCandles(symbol, '1h', 300);
  const selection = selectAppropriateAgents(symbol, candles, agentPool, {
    minEdgeToAct: opts.minEdgeToAct || 3,
    maxAgentsToActivate: opts.maxAgentsToActivate || 2
  });

  const activatedResults = [];
  for (const a of selection.activated) {
    const result = await checkAndUpdate(symbol, a.agent, opts);
    activatedResults.push({ ...result, activationReason: a.reason });
  }

  return {
    symbol,
    currentRegime: selection.currentRegime,
    agentsConsidered: agentPool.length,
    activated: activatedResults,
    skipped: selection.rejected.map(r => ({ strategyId: r.agent.strategyId, reason: r.reason }))
  };
}

module.exports = { checkAndUpdate, checkMultiAgent };
