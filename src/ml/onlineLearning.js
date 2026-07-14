/**
 * Online (incremental) learning: nudges an already-trained model's weights
 * using ONE new real-world example, instead of retraining from scratch.
 * This is the honest mechanism behind "learning over time" — the model's
 * prior knowledge (from the original 3000-candle training) is the STARTING
 * POINT, not discarded; each real outcome makes a small adjustment on top
 * of it. A small number of epochs on a tiny learning rate keeps single
 * trades from overwhelming everything learned before them — the same
 * caution principle as everywhere else in this app.
 */
function incrementalUpdate(model, features, actualLabel, opts = {}) {
  const { epochs = 3, dampening = 0.3 } = opts;

  // Temporarily shrink the model's own learning rate for this update so a
  // single real trade can't swing the weights as hard as a full training
  // batch did — this is the "cautious" part of cautious learning.
  const originalLr = model.lr;
  model.lr = originalLr * dampening;

  model.train([{ features, label: actualLabel }], epochs);

  model.lr = originalLr; // restore — this was a one-off nudge, not a new normal
  return model;
}

/**
 * Computes a trust multiplier (0.5x-1.5x) from a strategy's real recent
 * trade history — this is the "cautious understanding" mechanism: risk
 * scales DOWN if real trades have been losing lately, and only scales UP
 * modestly if there's a real, sustained track record of winning. Bounded
 * on both ends so it can never remove risk management entirely or
 * over-leverage on a lucky streak.
 */
function computeTrustMultiplier(tradeLog, opts = {}) {
  const { lookback = 20, minSampleForTrust = 10 } = opts;
  const recent = tradeLog.slice(-lookback);

  if (recent.length < minSampleForTrust) {
    return { multiplier: 0.7, reason: `Only ${recent.length} real trades logged — staying cautious until at least ${minSampleForTrust} exist.` };
  }

  const wins = recent.filter(t => t.pnlPct > 0).length;
  const winRate = wins / recent.length;
  const avgPnl = recent.reduce((a, t) => a + t.pnlPct, 0) / recent.length;

  // Centered on winRate=50%/avgPnl=0 giving multiplier=1.0; scales modestly
  // either direction, hard-clamped to [0.5, 1.5].
  let multiplier = 1.0 + (winRate - 0.5) * 0.6 + Math.sign(avgPnl) * Math.min(Math.abs(avgPnl), 2) * 0.05;
  multiplier = Math.max(0.5, Math.min(1.5, multiplier));

  return {
    multiplier: +multiplier.toFixed(2),
    recentWinRate: +(winRate * 100).toFixed(1),
    recentAvgPnlPct: +avgPnl.toFixed(2),
    sampleSize: recent.length,
    reason: multiplier < 0.9
      ? 'Recent real performance is weak — reducing position size as a caution.'
      : multiplier > 1.1
      ? 'Recent real performance has been consistently good — modestly increasing size.'
      : 'Recent real performance is roughly neutral — using baseline sizing.'
  };
}

module.exports = { incrementalUpdate, computeTrustMultiplier };
