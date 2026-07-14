const binanceClient = require('./binanceClient');
const { calculatePositionSize } = require('../strategy/riskManagement');
const marketData = require('../data/twelvedata');
const { getHighImpactEvents, flagCandlesNearEvents } = require('../data/economicCalendar');
const { getCarryDifferential } = require('../data/carry');
const { getFundingRateHistory } = require('../data/fundingRate');
const { getOrderBookImbalance } = require('../data/orderbook');
const { buildDataset } = require('../ml/features');
const { LogisticRegression } = require('../ml/logisticRegression');
const { NeuralNet } = require('../ml/neuralNet');
const { incrementalUpdate, computeTrustMultiplier } = require('../ml/onlineLearning');
const persistentStore = require('../data/persistentStore');

function getEffectiveSerializedModel(symbol, strategyId, originalSerializedModel) {
  const persisted = persistentStore.get(`model_${symbol}_${strategyId}`);
  return persisted || originalSerializedModel;
}

/**
 * Live position tracking — mirrors paperTradeLedger's structure exactly,
 * so the same mental model applies, but placeMarketOrder actually sends
 * real requests to Binance (testnet by default, see binanceClient.js).
 */
const liveLedger = new Map();

function reconstructModel(serializedModel) {
  if (serializedModel.modelType === 'neural') {
    const net = new NeuralNet(1, serializedModel.hiddenSize);
    net.W1 = serializedModel.W1; net.b1 = serializedModel.b1;
    net.W2 = serializedModel.W2; net.b2 = serializedModel.b2;
    return net;
  }
  const model = new LogisticRegression(serializedModel.weights.length);
  model.weights = serializedModel.weights;
  model.bias = serializedModel.bias;
  return model;
}

/**
 * Checks the live signal and, if conditions are met, places a REAL order
 * (testnet or live per BINANCE_LIVE env var). Requires explicit opt-in via
 * LIVE_TRADING_ENABLED=true — without it, this function only reports what
 * it WOULD have done, exactly like a dry run.
 */
async function checkAndExecute(symbol, strategyResult, opts = {}) {
  const {
    riskPerTradePct = 0.5,        // deliberately more conservative default than paper trading
    atrMultiplierForStop = 1.5,
    riskRewardRatio = 2.0,
    maxHoldCandles = 20,
    orderBookVetoThreshold = -0.2
  } = opts;

  const liveEnabled = process.env.LIVE_TRADING_ENABLED === 'true';
  const key = `${symbol}_${strategyResult.strategyId}`;
  const { strategy, serializedModel } = strategyResult;

  if (!liveLedger.has(key)) {
    liveLedger.set(key, { openPosition: null, closedTrades: [] });
  }
  const entry = liveLedger.get(key);

  const candles = await marketData.getCandles(symbol, '1h', 300);
  const events = await getHighImpactEvents(
    new Date(candles[0].closeTime).toISOString().slice(0, 10),
    new Date(candles[candles.length - 1].closeTime).toISOString().slice(0, 10)
  );
  const newsFlags = flagCandlesNearEvents(candles, events, 60);
  const carryDifferential = getCarryDifferential(symbol);
  const fundingRateHistory = await getFundingRateHistory(symbol);

  const dataset = buildDataset(candles, {
    horizon: strategy.horizon, targetPct: strategy.targetPct,
    newsFlags, carryDifferential, fundingRateHistory
  });
  if (dataset.length === 0) return { error: 'Not enough data to compute a signal.' };

  const latestRow = dataset[dataset.length - 1];
  const effectiveModel = getEffectiveSerializedModel(symbol, strategyResult.strategyId, serializedModel);
  const model = reconstructModel(effectiveModel);
  const proba = model.predictProba(latestRow.features);
  const signal = proba >= strategy.decisionThreshold ? 'long' : 'no_trade';
  const currentPrice = candles[candles.length - 1].close;
  const orderBook = await getOrderBookImbalance(symbol, 20);
  const orderBookConflicts = orderBook && orderBook.imbalance < orderBookVetoThreshold;

  const actions = [];

  // Manage existing position: check if we should close
  if (entry.openPosition) {
    const changePct = ((currentPrice - entry.openPosition.entryPrice) / entry.openPosition.entryPrice) * 100;
    const hitTP = currentPrice >= entry.openPosition.takeProfitPrice;
    const hitSL = currentPrice <= entry.openPosition.stopLossPrice;

    if (hitTP || hitSL) {
      if (liveEnabled) {
        const order = await binanceClient.placeMarketOrder(symbol, 'SELL', entry.openPosition.positionSizeDollars);
        actions.push({ type: 'EXECUTED_SELL', order });
      } else {
        actions.push({ type: 'WOULD_SELL', reason: hitTP ? 'take_profit' : 'stop_loss', dryRun: true });
      }
      const closedRecord = { ...entry.openPosition, exitPrice: currentPrice, pnlPct: +changePct.toFixed(2), outcome: hitTP ? 'take_profit' : 'stop_loss' };
      entry.closedTrades.push(closedRecord);

      // Same online-learning mechanism as paper trading: nudge the model
      // with this real outcome, persist it, so live and paper trading
      // share one continuously-improving memory per symbol/strategy.
      if (entry.openPosition.entryFeatures) {
        const actualLabel = closedRecord.pnlPct > 0 ? 1 : 0;
        const modelKey = `model_${symbol}_${strategyResult.strategyId}`;
        const modelToUpdate = reconstructModel(getEffectiveSerializedModel(symbol, strategyResult.strategyId, serializedModel));
        incrementalUpdate(modelToUpdate, entry.openPosition.entryFeatures, actualLabel);
        const updatedSerialized = strategy.modelType === 'neural'
          ? { modelType: 'neural', W1: modelToUpdate.W1, b1: modelToUpdate.b1, W2: modelToUpdate.W2, b2: modelToUpdate.b2, hiddenSize: strategy.hiddenSize }
          : { modelType: 'logistic', weights: modelToUpdate.weights, bias: modelToUpdate.bias };
        persistentStore.set(modelKey, updatedSerialized);
      }
      persistentStore.appendLog(`trades_${symbol}_${strategyResult.strategyId}`, {
        pnlPct: closedRecord.pnlPct, outcome: closedRecord.outcome, wasLive: liveEnabled
      });

      entry.openPosition = null;
    }
  } else if (signal === 'long' && !orderBookConflicts) {
    const trust = computeTrustMultiplier(persistentStore.getLog(`trades_${symbol}_${strategyResult.strategyId}`));
    const sizing = calculatePositionSize(candles, { capital: opts.capital || 100, riskPerTradePct: riskPerTradePct * trust.multiplier, atrMultiplierForStop });
    if (!sizing.error) {
      const takeProfitPrice = currentPrice + (currentPrice - sizing.stopLossPrice) * riskRewardRatio;
      const positionRecord = {
        entryPrice: currentPrice,
        positionSizeDollars: Math.min(sizing.positionSizeDollars, binanceClient.MAX_ORDER_USD),
        stopLossPrice: sizing.stopLossPrice,
        takeProfitPrice: +takeProfitPrice.toFixed(4),
        openedAt: Date.now(),
        entryFeatures: latestRow.features
      };

      if (liveEnabled) {
        const order = await binanceClient.placeMarketOrder(symbol, 'BUY', positionRecord.positionSizeDollars);
        actions.push({ type: 'EXECUTED_BUY', order });
      } else {
        actions.push({ type: 'WOULD_BUY', positionRecord, dryRun: true });
      }
      entry.openPosition = positionRecord;
    }
  }

  const tradeLog = persistentStore.getLog(`trades_${symbol}_${strategyResult.strategyId}`);
  const trust = computeTrustMultiplier(tradeLog);

  return {
    symbol,
    strategyId: strategyResult.strategyId,
    liveTradingEnabled: liveEnabled,
    isTestnet: !binanceClient.isLive,
    currentSignal: signal,
    signalProbability: +proba.toFixed(3),
    currentPrice,
    orderBookVetoedEntry: signal === 'long' && orderBookConflicts,
    learning: {
      usingLearnedModel: persistentStore.get(`model_${symbol}_${strategyResult.strategyId}`) != null,
      realTradesLogged: tradeLog.length,
      trustMultiplier: trust.multiplier,
      trustReason: trust.reason
    },
    openPosition: entry.openPosition,
    closedTrades: entry.closedTrades,
    actions
  };
}

module.exports = { checkAndExecute };
