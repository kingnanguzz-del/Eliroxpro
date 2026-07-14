const { FEATURE_NAMES } = require('./features');

/**
 * Turns raw numbers into plain-English reasoning, the way a professor
 * grading a thesis would explain the verdict rather than just posting a
 * score. No hype, no hedge-selling — just what the evidence supports.
 */
function explainWeights(weights) {
  const paired = weights.map((w, i) => ({ name: FEATURE_NAMES[i], weight: w }));
  paired.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const top = paired.slice(0, 3);
  return top.map(f =>
    `${f.name} (${f.weight > 0 ? 'pushes toward' : 'pushes against'} the target, weight ${f.weight})`
  );
}

function buildProfessorReport(symbol, foldSummary, significance, sampleWeights) {
  const lines = [];

  lines.push(`--- Evaluation: ${symbol} ---`);
  lines.push(`Across ${foldSummary.numFolds} walk-forward folds (each trained only on data before it, tested strictly on unseen future candles):`);
  lines.push(`  Mean out-of-sample accuracy: ${foldSummary.meanAccuracy}% (±${foldSummary.stdAccuracy}%)`);
  lines.push(`  Mean edge over baseline guessing: ${foldSummary.meanEdge > 0 ? '+' : ''}${foldSummary.meanEdge}% (±${foldSummary.stdEdge}%)`);

  if (!foldSummary.consistentAcrossFolds) {
    lines.push(`  The edge varies MORE across folds than its own average size — this means the "edge" is not a stable pattern, it's fold-to-fold noise. A professor would not accept this as a finding.`);
  } else {
    lines.push(`  The edge is reasonably consistent across folds, which is a necessary (not sufficient) condition for it being real.`);
  }

  lines.push(`Statistical test: z=${significance.z}, p=${significance.pValue} → ${significance.interpretation}`);

  if (significance.significant && foldSummary.consistentAcrossFolds && foldSummary.meanEdge > 3) {
    lines.push(`VERDICT: This clears a real bar — statistically significant AND consistent across folds. Still modest in size, and still needs testing on a live paper account before any real capital, but this is not noise.`);
    lines.push(`Most influential features: ${explainWeights(sampleWeights).join('; ')}`);
  } else if (significance.significant && !foldSummary.consistentAcrossFolds) {
    lines.push(`VERDICT: The significance test alone would look like a "yes," but the fold-to-fold instability contradicts it. This is the classic trap of trusting a single aggregate number — don't act on this without more data.`);
  } else {
    lines.push(`VERDICT: No defensible edge. This is what a coin flip looks like when you compute enough decimal places. Recommend not trading on this configuration.`);
  }

  return lines.join('\n');
}

module.exports = { buildProfessorReport, explainWeights };
