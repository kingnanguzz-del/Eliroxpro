const { buildDataset } = require('./features');
const { LogisticRegression } = require('./logisticRegression');
const marketData = require('../data/twelvedata');
const { getHighImpactEvents, flagCandlesNearEvents } = require('../data/economicCalendar');
const { getCarryDifferential } = require('../data/carry');
const { getFundingRateHistory } = require('../data/fundingRate');
const { significanceTest, summarizeFolds } = require('./statistics');
const { buildProfessorReport } = require('./report');

/**
 * Walk-forward cross-validation: instead of one train/test split (which can
 * simply get lucky or unlucky), we roll an expanding training window forward
 * across N folds. Fold k trains on everything before it, tests only on the
 * fold's own untouched slice. This is the actual academic standard for time
 * series validation — a single split is closer to grading yourself on your
 * own practice exam.
 */
function walkForwardFolds(dataset, numFolds = 5) {
  const foldSize = Math.floor(dataset.length / (numFolds + 1));
  const folds = [];
  for (let k = 1; k <= numFolds; k++) {
    const trainEnd = foldSize * k;
    const testEnd = foldSize * (k + 1);
    const trainSet = dataset.slice(0, trainEnd);
    const testSet = dataset.slice(trainEnd, testEnd);
    if (trainSet.length < 50 || testSet.length < 20) continue;
    folds.push({ trainSet, testSet });
  }
  return folds;
}

async function evaluateSymbol(symbol, interval = '1h', opts = {}) {
  const { candleCount = 3000, horizon = 5, targetPct = 0.5, numFolds = 5 } = opts;

  const candles = await marketData.getCandles(symbol, interval, candleCount);
  if (candles.length < 300) {
    throw new Error(`Not enough data returned for ${symbol} (${candles.length} candles) — try a different interval or fewer folds.`);
  }

  const firstTime = new Date(candles[0].closeTime).toISOString().slice(0, 10);
  const lastTime = new Date(candles[candles.length - 1].closeTime).toISOString().slice(0, 10);
  const events = await getHighImpactEvents(firstTime, lastTime);
  const newsFlags = flagCandlesNearEvents(candles, events, 60);

  const carryDifferential = getCarryDifferential(symbol);
  const fundingRateHistory = await getFundingRateHistory(symbol);
  const dataset = buildDataset(candles, { horizon, targetPct, newsFlags, carryDifferential, fundingRateHistory });
  if (dataset.length < 200) {
    throw new Error(`Not enough valid feature rows for ${symbol} — need more candles.`);
  }

  const folds = walkForwardFolds(dataset, numFolds);
  if (folds.length < 2) {
    throw new Error(`Not enough data for meaningful cross-validation on ${symbol} — increase candleCount.`);
  }

  const foldResults = [];
  let lastModel = null;

  for (const { trainSet, testSet } of folds) {
    const model = new LogisticRegression(dataset[0].features.length, 0.1, 0.001);
    model.train(trainSet, 300);
    const testEval = model.evaluate(testSet);
    foldResults.push({ testPerformance: testEval });
    lastModel = model;
  }

  const foldSummary = summarizeFolds(foldResults);
  const totalTestSamples = foldResults.reduce((a, f) => a + f.testPerformance.sampleSize, 0);
  const significance = significanceTest(foldSummary.meanAccuracy, foldResults[0].testPerformance.baseRatePositiveClass, totalTestSamples);

  const newsCandles = dataset.filter(r => r.features[6] === 1);
  const normalCandles = dataset.filter(r => r.features[6] === 0);
  const newsPositiveRate = newsCandles.length ? (newsCandles.filter(r => r.label === 1).length / newsCandles.length) * 100 : null;
  const normalPositiveRate = normalCandles.length ? (normalCandles.filter(r => r.label === 1).length / normalCandles.length) * 100 : null;

  const professorReport = buildProfessorReport(symbol, foldSummary, significance, lastModel.weights);

  return {
    symbol,
    interval,
    candlesUsed: candles.length,
    datasetSize: dataset.length,
    newsEventsFound: events.length,
    foldSummary,
    significance,
    edgeOverBaseline: foldSummary.meanEdge,
    newsImpact: {
      candlesNearNews: newsCandles.length,
      positiveRateNearNews: newsPositiveRate != null ? +newsPositiveRate.toFixed(1) : null,
      positiveRateNormal: normalPositiveRate != null ? +normalPositiveRate.toFixed(1) : null
    },
    modelWeights: lastModel.weights.map(w => +w.toFixed(4)),
    professorReport,
    verdict: significance.significant && foldSummary.consistentAcrossFolds && foldSummary.meanEdge > 3
      ? 'defensible edge — statistically significant and consistent across folds'
      : significance.significant && !foldSummary.consistentAcrossFolds
      ? 'inconclusive — significant on paper but unstable across folds'
      : 'no defensible edge — consistent with chance'
  };
}

async function scanSymbols(symbols, interval = '1h', opts = {}) {
  const results = [];
  for (const symbol of symbols) {
    try {
      const result = await evaluateSymbol(symbol, interval, opts);
      results.push(result);
    } catch (err) {
      results.push({ symbol, error: err.message });
    }
  }
  results.sort((a, b) => (b.edgeOverBaseline ?? -999) - (a.edgeOverBaseline ?? -999));
  return results;
}

module.exports = { evaluateSymbol, scanSymbols };
