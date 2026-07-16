const { buildDataset } = require('../ml/features');
const { LogisticRegression } = require('../ml/logisticRegression');
const { NeuralNet } = require('../ml/neuralNet');
const { significanceTest, summarizeFolds } = require('../ml/statistics');
const { buildProfessorReport } = require('../ml/report');
const { generateStrategySpace } = require('./strategySpace');
const { benjaminiHochberg } = require('./fdrCorrection');
const marketData = require('../data/twelvedata');
const { getHighImpactEvents, flagCandlesNearEvents } = require('../data/economicCalendar');
const { getCarryDifferential } = require('../data/carry');
const { getFundingRateHistory } = require('../data/fundingRate');

function createModel(numFeatures, strategy) {
  if (strategy.modelType === 'neural') {
    return new NeuralNet(numFeatures, strategy.hiddenSize, 0.05, strategy.l2);
  }
  return new LogisticRegression(numFeatures, 0.1, strategy.l2);
}

/**
 * STAGE 1 — cheap broad screen across every strategy in the search space.
 * Single chronological split (not full walk-forward — that's saved for
 * stage 2) so ~1000 strategies finish in a reasonable time on a free-tier
 * server. This stage's only job is to narrow 1000 down to a defensible
 * shortlist; its numbers are NOT the final word.
 */
function quickScreen(datasetsByKey, strategy) {
  const key = `${strategy.horizon}_${strategy.targetPct}`;
  const dataset = datasetsByKey[key];
  if (!dataset || dataset.length < 150) return null;

  const splitIdx = Math.floor(dataset.length * 0.75);
  const trainSet = dataset.slice(0, splitIdx);
  const testSet = dataset.slice(splitIdx);
  if (trainSet.length < 80 || testSet.length < 30) return null;

  const epochs = strategy.modelType === 'neural' ? 100 : 150;
  const model = createModel(dataset[0].features.length, strategy);
  model.train(trainSet, epochs);
  const testEval = model.evaluate(testSet, strategy.decisionThreshold);
  const significance = significanceTest(testEval.accuracy, testEval.baseRatePositiveClass, testEval.sampleSize);

  return {
    strategyId: strategy.id,
    strategy,
    quickEdge: +(testEval.accuracy - testEval.baseRatePositiveClass).toFixed(1),
    significance,
    quickSampleSize: testEval.sampleSize
  };
}

/**
 * STAGE 2 — rigorous walk-forward re-validation, same standard we built
 * earlier, but only run on the shortlist that survived FDR correction.
 * This is what actually decides "best 2."
 */
const { classifyRegimes } = require('./regimeDetection');

function deepValidate(candles, strategy, newsFlags, carryDifferential, fundingRateHistory) {
  const dataset = buildDataset(candles, {
    horizon: strategy.horizon,
    targetPct: strategy.targetPct,
    newsFlags,
    carryDifferential,
    fundingRateHistory
  });
  const regimes = classifyRegimes(candles);

  const numFolds = 5;
  const foldSize = Math.floor(dataset.length / (numFolds + 1));
  const foldResults = [];
  let lastModel = null;

  // Per-regime tracking: instead of one blended accuracy number, we record
  // every prediction alongside the regime it happened in, so we can later
  // answer "does this strategy actually work in trending markets, or only
  // in the overall average that happens to include both good and bad fits."
  const regimePredictions = {}; // regimeLabel -> [{predicted, actual}]

  for (let k = 1; k <= numFolds; k++) {
    const trainEnd = foldSize * k;
    const testEnd = foldSize * (k + 1);
    const trainSet = dataset.slice(0, trainEnd);
    const testSet = dataset.slice(trainEnd, testEnd);
    if (trainSet.length < 50 || testSet.length < 20) continue;

    const epochs = strategy.modelType === 'neural' ? 150 : 250;
    const model = createModel(dataset[0].features.length, strategy);
    model.train(trainSet, epochs);
    const testEval = model.evaluate(testSet, strategy.decisionThreshold);
    foldResults.push({ testPerformance: testEval });
    lastModel = model;

    for (const row of testSet) {
      const regimeLabel = regimes[row.index];
      if (!regimeLabel) continue;
      const predicted = model.predictProba(row.features) >= strategy.decisionThreshold ? 1 : 0;
      if (!regimePredictions[regimeLabel]) regimePredictions[regimeLabel] = [];
      regimePredictions[regimeLabel].push({ predicted, actual: row.label });
    }
  }

  if (foldResults.length < 2) return null;

  // Collapse each regime's predictions into an accuracy-vs-baseline edge,
  // same honest majority-class comparison used everywhere else in this app.
  const regimePerformance = {};
  for (const [regimeLabel, preds] of Object.entries(regimePredictions)) {
    if (preds.length < 15) continue; // too few samples in this regime to trust
    const correct = preds.filter(p => p.predicted === p.actual).length;
    const accuracy = (correct / preds.length) * 100;
    const positiveRate = (preds.filter(p => p.actual === 1).length / preds.length) * 100;
    const baseline = Math.max(positiveRate, 100 - positiveRate);
    regimePerformance[regimeLabel] = {
      sampleSize: preds.length,
      accuracy: +accuracy.toFixed(1),
      baseline: +baseline.toFixed(1),
      edge: +(accuracy - baseline).toFixed(1)
    };
  }

  const foldSummary = summarizeFolds(foldResults);
  const totalTestSamples = foldResults.reduce((a, f) => a + f.testPerformance.sampleSize, 0);
  const significance = significanceTest(foldSummary.meanAccuracy, foldResults[0].testPerformance.baseRatePositiveClass, totalTestSamples);
  const weights = lastModel.W2 ? lastModel.W2 : lastModel.weights; // neural nets don't have a single clean weight vector per input feature

  const label = `strategy_${strategy.id} (${strategy.modelType}, horizon=${strategy.horizon}, target=${strategy.targetPct}%, thresh=${strategy.decisionThreshold})`;
  const professorReport = buildProfessorReport(label, foldSummary, significance, lastModel.weights || []);

  // Serialize enough of the model to reconstruct it later for live signal
  // checks, without retraining from scratch every time.
  const serializedModel = strategy.modelType === 'neural'
    ? { modelType: 'neural', W1: lastModel.W1, b1: lastModel.b1, W2: lastModel.W2, b2: lastModel.b2, hiddenSize: strategy.hiddenSize }
    : { modelType: 'logistic', weights: lastModel.weights, bias: lastModel.bias };

  return {
    strategyId: strategy.id,
    strategy,
    foldSummary,
    significance,
    edgeOverBaseline: foldSummary.meanEdge,
    professorReport,
    serializedModel,
    regimePerformance,
    verdict: significance.significant && foldSummary.consistentAcrossFolds && foldSummary.meanEdge > 3
      ? 'defensible edge — statistically significant and consistent across folds'
      : significance.significant && !foldSummary.consistentAcrossFolds
      ? 'inconclusive — significant on paper but unstable across folds'
      : 'no defensible edge — consistent with chance'
  };
}

/**
 * Full pipeline: fetch data once, screen ~1000 strategies cheaply, FDR-correct,
 * deep-validate survivors, return top 10 with top 2 flagged for paper trading.
 */
async function searchStrategies(symbol, interval = '1h', opts = {}) {
  const { candleCount = 3000, fdrLevel = 0.05, onProgress = null, useBulkHistory = false, yearsBack = 5 } = opts;

  let candles;
  if (useBulkHistory) {
    // Pulls years of data from Binance's free bulk archive — no rate limits,
    // no per-request friction, cached locally after the first download.
    const { getBulkHistory } = require('../data/bulk/bulkDataLoader');
    candles = await getBulkHistory(symbol, interval, yearsBack, (done, total) => {
      if (onProgress) onProgress(done, total, 'downloading_bulk_history');
    });
  } else {
    candles = await marketData.getCandles(symbol, interval, candleCount);
  }

  if (candles.length < 300) {
    throw new Error(`Not enough data for ${symbol} (${candles.length} candles). ${useBulkHistory ? 'Bulk archive may not cover this symbol/interval — try a major pair like BTC/USDT.' : ''}`);
  }

  const firstTime = new Date(candles[0].closeTime).toISOString().slice(0, 10);
  const lastTime = new Date(candles[candles.length - 1].closeTime).toISOString().slice(0, 10);
  const events = await getHighImpactEvents(firstTime, lastTime);
  const newsFlags = flagCandlesNearEvents(candles, events, 60);
  const carryDifferential = getCarryDifferential(symbol);
  const fundingRateHistory = await getFundingRateHistory(symbol);

  const strategies = generateStrategySpace();

  // Precompute datasets per unique (horizon, targetPct) pair — reused across
  // all strategies that share those values, instead of rebuilding 1000 times.
  const uniquePairs = new Set(strategies.map(s => `${s.horizon}_${s.targetPct}`));
  const datasetsByKey = {};
  for (const key of uniquePairs) {
    const [horizon, targetPct] = key.split('_').map(Number);
    datasetsByKey[key] = buildDataset(candles, { horizon, targetPct, newsFlags, carryDifferential, fundingRateHistory });
  }

  // STAGE 1: screen everything
  const screenResults = [];
  for (let i = 0; i < strategies.length; i++) {
    const r = quickScreen(datasetsByKey, strategies[i]);
    if (r !== null) screenResults.push(r);
    if (onProgress && i % 20 === 0) onProgress(i, strategies.length, 'screening');
  }

  // FDR correction across the whole batch
  const corrected = benjaminiHochberg(screenResults, fdrLevel);
  let shortlist = corrected.filter(r => r.survivesFDR);

  // Fallback: if literally nothing survives correction (common and honest —
  // means no real edge exists in this space for this symbol), still surface
  // the least-bad candidates for transparency, clearly labeled as such.
  const usedFallback = shortlist.length === 0;
  if (usedFallback) {
    shortlist = [...corrected].sort((a, b) => a.significance.pValue - b.significance.pValue).slice(0, 10);
  }

  // STAGE 2: rigorous re-validation on shortlist only
  const validated = [];
  for (let i = 0; i < shortlist.length; i++) {
    if (onProgress) onProgress(i, shortlist.length, 'deep_validation');
    const r = deepValidate(candles, shortlist[i].strategy, newsFlags, carryDifferential, fundingRateHistory);
    if (r !== null) validated.push(r);
  }
  validated.sort((a, b) => b.edgeOverBaseline - a.edgeOverBaseline);

  const top10 = validated.slice(0, 10);
  const qualifying = top10.filter(r => r.verdict.startsWith('defensible'));
  const paperTradeCandidates = qualifying.slice(0, 2);           // "trade best 2"

  // Persistent leaderboard: every genuinely-validated result gets submitted.
  // This is what "maintaining previous winning ones" actually means — good
  // strategies accumulate here across every search you ever run, not just
  // this one, and are never silently discarded by a later run.
  const { considerCandidate } = require('./strategyLeaderboard');
  const leaderboardUpdates = validated.map(r => ({
    strategyId: r.strategyId,
    ...considerCandidate(symbol, interval, r)
  })).filter(u => u.accepted);
  const suggested = top10
    .filter(r => !paperTradeCandidates.includes(r))
    .slice(0, 8);                                                 // "suggest 8"

  return {
    symbol,
    interval,
    dataSource: useBulkHistory ? `bulk_historical (${yearsBack} years, ${candles.length} candles)` : `live_api (${candles.length} candles)`,
    totalStrategiesTested: strategies.length,
    survivedFDRCorrection: usedFallback ? 0 : shortlist.length,
    usedFallbackRanking: usedFallback,
    leaderboardUpdates,
    top10,
    suggested8: suggested,
    paperTrade2: paperTradeCandidates,
    honestSummary: usedFallback
      ? `None of ${strategies.length} strategies survived false-discovery-rate correction — meaning nothing tested here shows a real, defensible edge for ${symbol}. The 10 shown below are just the least-bad by raw p-value, for transparency, not because they're actually good.`
      : `${shortlist.length} of ${strategies.length} strategies survived FDR correction. ${paperTradeCandidates.length} qualified as paper-trade candidates; ${suggested.length} more are shown as suggestions only.`
  };
}

module.exports = { searchStrategies };
