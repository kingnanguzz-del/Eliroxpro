/**
 * Benjamini-Hochberg FDR correction. When you test many strategies at once,
 * some will show p<0.05 purely by chance — testing 1000 strategies at that
 * threshold produces ~50 false "discoveries" even if NONE of them have a
 * real edge. This reranks p-values and adjusts the bar so the false
 * discovery rate stays controlled at `fdrLevel` across the whole batch.
 * Without this step, "best 10 of 1000" is indistinguishable from "luckiest
 * 10 of 1000" — this is the step that tells them apart.
 */
function benjaminiHochberg(results, fdrLevel = 0.05) {
  const withPValues = results.filter(r => r.significance && typeof r.significance.pValue === 'number');
  const m = withPValues.length;
  if (m === 0) return results.map(r => ({ ...r, survivesFDR: false }));

  const sorted = [...withPValues].sort((a, b) => a.significance.pValue - b.significance.pValue);

  let largestPassingRank = -1;
  for (let i = 0; i < m; i++) {
    const rank = i + 1;
    const threshold = (rank / m) * fdrLevel;
    if (sorted[i].significance.pValue <= threshold) largestPassingRank = rank;
  }

  const passingIds = new Set(
    largestPassingRank > 0 ? sorted.slice(0, largestPassingRank).map(r => r.strategyId) : []
  );

  return results.map(r => ({ ...r, survivesFDR: passingIds.has(r.strategyId) }));
}

module.exports = { benjaminiHochberg };
