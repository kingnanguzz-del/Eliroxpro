const { FEATURE_NAMES } = require('../ml/features');
const persistentStore = require('../data/persistentStore');

/**
 * Studies a strategy's own real trade history to find which specific
 * feature conditions have actually been associated with losses. This is
 * the honest version of "learn from mistakes": not a promise to eliminate
 * losses, but a concrete mechanism to recognize "this is the kind of
 * setup that has burned us before" and reduce exposure to it — the same
 * way a careful trader keeps a journal and notices their own bad patterns,
 * except this one actually remembers every single instance, unfiltered by
 * ego or memory.
 */
function analyzeLossPatterns(symbol, strategyId, opts = {}) {
  const { minSampleSize = 15 } = opts;
  const tradeLog = persistentStore.getLog(`trades_${symbol}_${strategyId}`);

  if (tradeLog.length < minSampleSize) {
    return { available: false, reason: `Only ${tradeLog.length} real trades logged — need at least ${minSampleSize} before patterns are trustworthy rather than noise.` };
  }

  const withFeatures = tradeLog.filter(t => Array.isArray(t.entryFeatures));
  if (withFeatures.length < minSampleSize) {
    return { available: false, reason: 'Not enough logged trades include feature data to analyze (older trades logged before this was tracked).' };
  }

  const losses = withFeatures.filter(t => t.pnlPct <= 0);
  const wins = withFeatures.filter(t => t.pnlPct > 0);

  if (losses.length < 5) {
    return { available: true, flaggedConditions: [], reason: `Only ${losses.length} losses recorded so far — too few to responsibly generalize a pattern. Good sign, not something to force an analysis onto.` };
  }

  // For each feature, compare its average value in losing trades vs winning
  // trades. A meaningful, consistent gap suggests "losses tend to happen
  // when this feature is unusually high/low" — flagged as a caution, not
  // a hard rule, since correlation here is not the same as proof.
  const flaggedConditions = [];
  const numFeatures = withFeatures[0].entryFeatures.length;

  for (let f = 0; f < numFeatures; f++) {
    const lossValues = losses.map(t => t.entryFeatures[f]);
    const winValues = wins.map(t => t.entryFeatures[f]);
    if (winValues.length === 0) continue;

    const lossMean = lossValues.reduce((a, b) => a + b, 0) / lossValues.length;
    const winMean = winValues.reduce((a, b) => a + b, 0) / winValues.length;
    const gap = lossMean - winMean;

    // Only flag a real, sizeable divergence — not noise from a handful of trades
    if (Math.abs(gap) > 0.25 && losses.length >= 8) {
      flaggedConditions.push({
        feature: FEATURE_NAMES[f] || `feature_${f}`,
        lossAverage: +lossMean.toFixed(3),
        winAverage: +winMean.toFixed(3),
        direction: gap > 0 ? 'losses cluster when this feature is HIGHER than usual' : 'losses cluster when this feature is LOWER than usual',
        sampleSize: { losses: losses.length, wins: winValues.length }
      });
    }
  }

  return {
    available: true,
    totalLosses: losses.length,
    totalWins: wins.length,
    flaggedConditions,
    verdict: flaggedConditions.length > 0
      ? `Found ${flaggedConditions.length} feature(s) where losses show a real pattern — worth treating as a caution flag going forward.`
      : 'No clear feature pattern in past losses — they look more like normal variance than a fixable mistake.'
  };
}

/**
 * Checks the CURRENT feature vector against known loss patterns for this
 * strategy — used by the coordinator as an additional veto, alongside
 * regime matching and order book confirmation.
 */
function matchesKnownLossPattern(currentFeatures, lossAnalysis) {
  if (!lossAnalysis.available || lossAnalysis.flaggedConditions.length === 0) {
    return { matches: false };
  }

  const matched = [];
  for (const condition of lossAnalysis.flaggedConditions) {
    const featureIndex = FEATURE_NAMES.indexOf(condition.feature);
    if (featureIndex === -1) continue;
    const currentValue = currentFeatures[featureIndex];
    const closerToLoss = Math.abs(currentValue - condition.lossAverage) < Math.abs(currentValue - condition.winAverage);
    if (closerToLoss) matched.push(condition.feature);
  }

  return {
    matches: matched.length > 0,
    matchedFeatures: matched,
    reason: matched.length > 0
      ? `Current conditions resemble past losses on: ${matched.join(', ')}`
      : null
  };
}

module.exports = { analyzeLossPatterns, matchesKnownLossPattern };
