/**
 * Statistical rigor layer — the "does this actually mean anything" check
 * that separates real findings from noise dressed up as a result.
 */

// Standard normal CDF approximation (Abramowitz & Stegun 7.1.26)
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) prob = 1 - prob;
  return prob;
}

/**
 * One-sided z-test: is observed accuracy significantly ABOVE the baseline
 * (majority-class) rate, given the sample size? Returns a p-value.
 * Low p-value (<0.05) = unlikely to be chance. This is the actual bar
 * a real finding needs to clear, not just "bigger than baseline."
 */
function significanceTest(observedAccuracyPct, baselinePct, sampleSize) {
  const p0 = baselinePct / 100;
  const pHat = observedAccuracyPct / 100;
  if (sampleSize === 0) return { z: 0, pValue: 1, significant: false };

  const stdErr = Math.sqrt((p0 * (1 - p0)) / sampleSize);
  if (stdErr === 0) return { z: 0, pValue: 1, significant: false };

  const z = (pHat - p0) / stdErr;
  const pValue = 1 - normalCDF(z);

  return {
    z: +z.toFixed(2),
    pValue: +pValue.toFixed(4),
    significant: pValue < 0.05,
    interpretation: pValue < 0.01 ? 'strong evidence of real edge'
      : pValue < 0.05 ? 'weak but statistically real edge'
      : pValue < 0.2 ? 'inconclusive — could easily be chance'
      : 'no evidence of edge — consistent with pure chance'
  };
}

/**
 * Aggregates results across multiple walk-forward folds into mean/std,
 * so a single lucky fold can't masquerade as a robust finding.
 */
function summarizeFolds(foldResults) {
  const accuracies = foldResults.map(f => f.testPerformance.accuracy);
  const edges = foldResults.map(f => f.testPerformance.accuracy - f.testPerformance.baseRatePositiveClass);
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = arr => {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  };

  return {
    numFolds: foldResults.length,
    meanAccuracy: +mean(accuracies).toFixed(1),
    stdAccuracy: +std(accuracies).toFixed(1),
    meanEdge: +mean(edges).toFixed(1),
    stdEdge: +std(edges).toFixed(1),
    consistentAcrossFolds: std(edges) < Math.abs(mean(edges)) // edge bigger than its own noise
  };
}

module.exports = { significanceTest, summarizeFolds };
