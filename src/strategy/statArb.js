const marketData = require('../data/twelvedata');
const { significanceTest } = require('../ml/statistics');

/**
 * Pairs / stat-arb trading: instead of predicting price DIRECTION (what
 * everything else in this app does), this trades the SPREAD between two
 * correlated assets reverting to its historical mean. This is a genuinely
 * different mechanism — it doesn't compete with the same crowded RSI/MACD
 * retail signals, because it isn't a directional bet on either asset alone.
 *
 * Mechanics: compute the price ratio (or log-spread) between two symbols,
 * z-score it against a rolling window. When the z-score is extreme, bet on
 * reversion — short the outperformer, long the underperformer (approximated
 * here as a single "spread trade" rather than two separate leg positions).
 */
function computeSpreadSeries(candlesA, candlesB) {
  // Align by timestamp — the two series may not have identical candle counts
  const mapB = new Map(candlesB.map(c => [c.closeTime, c.close]));
  const spread = [];
  for (const a of candlesA) {
    const bClose = mapB.get(a.closeTime);
    if (bClose == null || bClose === 0) continue;
    spread.push({ time: a.closeTime, ratio: a.close / bClose });
  }
  return spread;
}

function rollingZScore(series, window = 50) {
  const out = new Array(series.length).fill(null);
  for (let i = window; i < series.length; i++) {
    const slice = series.slice(i - window, i).map(s => s.ratio);
    const mean = slice.reduce((a, b) => a + b, 0) / window;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / window;
    const std = Math.sqrt(variance);
    out[i] = std > 0 ? (series[i].ratio - mean) / std : 0;
  }
  return out;
}

/**
 * Walk-forward backtest of the mean-reversion rule: enter when |z| exceeds
 * entryZ, exit when z reverts back through exitZ (or times out). Same
 * no-lookahead discipline as the rest of the app — z-score at candle i only
 * uses data up to and including i.
 */
/**
 * Simplified Augmented Dickey-Fuller test: regresses Δy_t on y_{t-1} via OLS.
 * A significantly negative coefficient means the series pulls back toward
 * its own mean (stationary/mean-reverting) rather than wandering freely
 * (random walk / non-stationary). This is the actual gate that separates
 * genuine pairs trading from the trap just demonstrated: two UNRELATED
 * random walks can produce a misleadingly high "win rate" on a rolling
 * z-score strategy, purely because the rolling window chases the drift —
 * not because the spread is really mean-reverting. Skip this test and
 * you will find fake edges constantly.
 *
 * Critical value: -2.86 is the commonly cited approximate 5% critical
 * value for the no-trend ADF case — an approximation of published
 * MacKinnon tables, adequate as a gate, not a substitute for rigorous
 * econometric software.
 */
function adfTest(series, criticalValue = -2.86) {
  const y = series.map(s => s.ratio);
  const n = y.length;
  if (n < 30) return { isStationary: false, tStat: null, reason: 'not enough data' };

  const yLag = y.slice(0, n - 1);
  const dy = y.slice(1).map((v, i) => v - yLag[i]);

  const meanYLag = yLag.reduce((a, b) => a + b, 0) / yLag.length;
  const meanDy = dy.reduce((a, b) => a + b, 0) / dy.length;

  let num = 0, denom = 0;
  for (let i = 0; i < yLag.length; i++) {
    num += (yLag[i] - meanYLag) * (dy[i] - meanDy);
    denom += (yLag[i] - meanYLag) ** 2;
  }
  const gamma = denom !== 0 ? num / denom : 0;

  // Residual standard error for the t-stat
  let ssRes = 0;
  const alpha = meanDy - gamma * meanYLag;
  for (let i = 0; i < yLag.length; i++) {
    const predicted = alpha + gamma * yLag[i];
    ssRes += (dy[i] - predicted) ** 2;
  }
  const dof = yLag.length - 2;
  const stdErrGamma = dof > 0 ? Math.sqrt(ssRes / dof / denom) : Infinity;
  const tStat = stdErrGamma > 0 ? gamma / stdErrGamma : 0;

  return {
    isStationary: tStat < criticalValue,
    tStat: +tStat.toFixed(3),
    criticalValue,
    interpretation: tStat < criticalValue
      ? 'spread shows real mean-reversion — stat arb logic applies'
      : 'spread behaves like a random walk — stat arb would produce misleading results here'
  };
}

function backtestStatArb(candlesA, candlesB, opts = {}) {
  const { window = 50, entryZ = 2.0, exitZ = 0.5, maxHoldCandles = 30 } = opts;

  const spread = computeSpreadSeries(candlesA, candlesB);

  // GATE: only proceed if the spread is actually stationary. This is not
  // optional — skipping it is exactly how the false "65% win rate on pure
  // noise" result above happens.
  const stationarity = adfTest(spread);
  if (!stationarity.isStationary) {
    return {
      totalTrades: 0,
      winRate: null,
      totalReturnPct: 0,
      stationarity,
      significance: null,
      verdict: `Not tradeable as a pair: ${stationarity.interpretation} (t-stat ${stationarity.tStat} vs required ${stationarity.criticalValue}). No backtest was run — running one anyway would produce misleading results.`,
      trades: []
    };
  }

  const zScores = rollingZScore(spread, window);

  const trades = [];
  let openTrade = null;

  for (let i = window; i < spread.length; i++) {
    const z = zScores[i];
    if (z == null) continue;

    if (openTrade) {
      const heldCandles = i - openTrade.entryIndex;
      const reverted = openTrade.direction === 'short_spread' ? z <= exitZ : z >= -exitZ;
      const timedOut = heldCandles >= maxHoldCandles;

      if (reverted || timedOut) {
        const exitRatio = spread[i].ratio;
        const changePct = ((exitRatio - openTrade.entryRatio) / openTrade.entryRatio) * 100 *
          (openTrade.direction === 'short_spread' ? -1 : 1);
        trades.push({ ...openTrade, exitIndex: i, exitRatio, pnlPct: changePct, outcome: reverted ? 'reverted' : 'timeout' });
        openTrade = null;
      }
      continue;
    }

    if (z >= entryZ) {
      openTrade = { entryIndex: i, entryRatio: spread[i].ratio, entryZ: z, direction: 'short_spread' };
    } else if (z <= -entryZ) {
      openTrade = { entryIndex: i, entryRatio: spread[i].ratio, entryZ: z, direction: 'long_spread' };
    }
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const totalReturn = trades.reduce((a, t) => a + t.pnlPct, 0);
  const significance = significanceTest(winRate, 50, trades.length); // null hypothesis: 50/50 like a coin flip

  return {
    totalTrades: trades.length,
    winRate: +winRate.toFixed(1),
    totalReturnPct: +totalReturn.toFixed(2),
    stationarity,
    significance,
    verdict: significance.significant && trades.length >= 20
      ? 'statistically real mean-reversion pattern — worth further testing'
      : trades.length < 20
      ? 'not enough trades in this window to draw a conclusion — needs more data'
      : 'no defensible edge — consistent with chance',
    trades: trades.slice(-20) // last 20 for inspection, not the full history
  };
}

async function runStatArb(symbolA, symbolB, interval = '1h', opts = {}) {
  const { candleCount = 1000 } = opts;
  const [candlesA, candlesB] = await Promise.all([
    marketData.getCandles(symbolA, interval, candleCount),
    marketData.getCandles(symbolB, interval, candleCount)
  ]);

  if (candlesA.length < 200 || candlesB.length < 200) {
    throw new Error(`Not enough data for ${symbolA}/${symbolB} pair.`);
  }

  const result = backtestStatArb(candlesA, candlesB, opts);
  return { symbolA, symbolB, interval, ...result };
}

module.exports = { runStatArb, backtestStatArb, computeSpreadSeries, rollingZScore };
