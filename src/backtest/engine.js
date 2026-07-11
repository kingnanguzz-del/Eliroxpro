const { scoreLatest } = require('../analytics/confluence');

function runBacktest(candles, opts = {}) {
  const {
    entryThreshold = 65,
    stopLossPct = 1.0,
    takeProfitPct = 2.0,
    maxHoldCandles = 20,
    minWarmup = 60
  } = opts;

  const trades = [];
  let openTrade = null;

  for (let i = minWarmup; i < candles.length; i++) {
    const windowSlice = candles.slice(0, i + 1);
    const price = candles[i].close;

    if (openTrade) {
      const heldFor = i - openTrade.entryIndex;
      const changePct = ((price - openTrade.entryPrice) / openTrade.entryPrice) * 100 *
        (openTrade.direction === 'bullish' ? 1 : -1);

      const hitTP = changePct >= takeProfitPct;
      const hitSL = changePct <= -stopLossPct;
      const timedOut = heldFor >= maxHoldCandles;

      if (hitTP || hitSL || timedOut) {
        const result = { ...openTrade, exitPrice: price, exitIndex: i, pnlPct: changePct, outcome: hitTP ? 'take_profit' : hitSL ? 'stop_loss' : 'timeout' };
        trades.push(result);
        openTrade = null;
      }
      continue;
    }

    let signal;
    try {
      signal = scoreLatest(windowSlice);
    } catch (e) {
      continue;
    }

    if (signal.score >= entryThreshold && signal.direction !== 'neutral') {
      openTrade = {
        entryIndex: i,
        entryPrice: price,
        direction: signal.direction,
        score: signal.score
      };
    }
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0;
  const expectancy = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;

  let cumulative = 0, peak = 0, maxDD = 0;
  const equityCurve = [];
  for (const t of trades) {
    cumulative += t.pnlPct;
    equityCurve.push(cumulative);
    peak = Math.max(peak, cumulative);
    maxDD = Math.min(maxDD, cumulative - peak);
  }

  return {
    totalTrades: trades.length,
    winRate: winRate.toFixed(1),
    avgWinPct: avgWin.toFixed(2),
    avgLossPct: avgLoss.toFixed(2),
    expectancyPct: expectancy.toFixed(3),
    totalReturnPct: cumulative.toFixed(2),
    maxDrawdownPct: maxDD.toFixed(2),
    trades,
    equityCurve
  };
}

module.exports = { runBacktest };
