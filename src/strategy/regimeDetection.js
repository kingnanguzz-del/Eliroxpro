const { ema, atr } = require('../indicators');

/**
 * Classifies each candle into a market regime. This is the actual answer
 * to "when is this strategy appropriate" — a trend-following strategy and
 * a mean-reversion strategy make opposite assumptions about the market,
 * and neither is "better," they just apply to different conditions.
 *
 * Regimes:
 * - trending_up / trending_down: EMA20 meaningfully separated from EMA50
 * - ranging: EMAs close together, no clear trend
 * Each crossed with volatility (high/low ATR%) giving 4 total regimes.
 */
function classifyRegimes(candles) {
  const closes = candles.map(c => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atrArr = atr(candles, 14);

  const regimes = new Array(candles.length).fill(null);

  for (let i = 50; i < candles.length; i++) {
    if (ema20[i] == null || ema50[i] == null || atrArr[i] == null) continue;

    const avgClose = closes.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;
    const trendSeparationPct = ((ema20[i] - ema50[i]) / avgClose) * 100;
    const atrPct = (atrArr[i] / avgClose) * 100;

    let trendLabel;
    if (trendSeparationPct > 0.3) trendLabel = 'trending_up';
    else if (trendSeparationPct < -0.3) trendLabel = 'trending_down';
    else trendLabel = 'ranging';

    // Volatility threshold is relative to the symbol's own recent history,
    // not a fixed number — a "high vol" day for a forex pair and a crypto
    // pair look nothing alike in absolute ATR%.
    const recentAtrPcts = [];
    for (let j = Math.max(50, i - 100); j < i; j++) {
      if (atrArr[j] != null) {
        const avgC = closes.slice(Math.max(0, j - 20), j).reduce((a, b) => a + b, 0) / Math.min(20, j);
        recentAtrPcts.push((atrArr[j] / avgC) * 100);
      }
    }
    const medianAtrPct = recentAtrPcts.length
      ? recentAtrPcts.sort((a, b) => a - b)[Math.floor(recentAtrPcts.length / 2)]
      : atrPct;
    const volLabel = atrPct > medianAtrPct * 1.3 ? 'high_vol' : 'low_vol';

    regimes[i] = `${trendLabel}_${volLabel}`;
  }

  return regimes;
}

function regimeSummary(regimes) {
  const counts = {};
  for (const r of regimes) {
    if (r == null) continue;
    counts[r] = (counts[r] || 0) + 1;
  }
  return counts;
}

module.exports = { classifyRegimes, regimeSummary };
