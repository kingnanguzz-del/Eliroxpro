const { classifyRegimes } = require('./regimeDetection');
const persistentStore = require('../data/persistentStore');

/**
 * Gets the regime label for the CURRENT (most recent) candle by running
 * the full-series classifier and taking its last entry — classifyRegimes
 * needs the trailing window of history to compute EMA/ATR, so we can't
 * classify a single point in isolation.
 */
function getCurrentRegimeLabel(candles) {
  const regimes = classifyRegimes(candles);
  const label = regimes[regimes.length - 1];
  return label || null;
}

/**
 * This is the actual "multi-agent" layer: each validated strategy from the
 * search is treated as an independent agent with its own specialization
 * (which regime it actually works in, from the backtest breakdown) and its
 * own track record (from real trade outcomes, accumulating over time). The
 * coordinator's job is narrow and honest: given the CURRENT regime, decide
 * which agent (if any) has genuine standing to act right now, and say why
 * the others were passed over — "drop irrelevant" made concrete rather
 * than just asserted.
 */

/**
 * Blends backtested regime performance with any accumulated real-trade
 * evidence for that specific regime — real outcomes should count for more
 * once there are enough of them, but a handful of live trades shouldn't
 * override a much larger backtested sample either.
 */
function getBlendedRegimeEdge(symbol, strategyId, regimeLabel, backtestRegimePerf) {
  const backtested = backtestRegimePerf?.[regimeLabel];
  const realLog = persistentStore.getLog(`trades_${symbol}_${strategyId}`)
    .filter(t => t.regimeLabel === regimeLabel);

  if (!backtested && realLog.length === 0) {
    return { edge: null, sampleSize: 0, source: 'none', reason: 'No backtested or real data for this regime.' };
  }

  if (realLog.length >= 15) {
    // Enough real evidence to matter on its own — this is the "learn from
    // past mistakes" mechanism made regime-specific: if a strategy has
    // actually been losing in THIS regime in real trades, that overrides
    // an optimistic backtest number for that same regime.
    const wins = realLog.filter(t => t.pnlPct > 0).length;
    const realWinRate = (wins / realLog.length) * 100;
    const realEdge = realWinRate - 50;
    return { edge: +realEdge.toFixed(1), sampleSize: realLog.length, source: 'real_trades', reason: `${realLog.length} real trades in this regime, ${realWinRate.toFixed(1)}% win rate.` };
  }

  if (backtested) {
    return { edge: backtested.edge, sampleSize: backtested.sampleSize, source: 'backtest', reason: `Backtested on ${backtested.sampleSize} historical candles in this regime.` };
  }

  return { edge: null, sampleSize: realLog.length, source: 'insufficient', reason: `Only ${realLog.length} real trades, not enough to judge yet.` };
}

/**
 * Given the current candles and a pool of candidate agents (from the
 * strategy search), picks which agent(s) are actually appropriate right
 * now. Returns a ranked list with explicit accept/reject reasoning for
 * every agent — nothing gets silently dropped without a stated reason.
 */
function selectAppropriateAgents(symbol, candles, candidateAgents, opts = {}) {
  const { minEdgeToAct = 3, maxAgentsToActivate = 2 } = opts;
  const currentRegimeLabel = getCurrentRegimeLabel(candles);

  if (!currentRegimeLabel) {
    return { currentRegime: null, activated: [], rejected: candidateAgents.map(a => ({ agent: a, reason: 'Not enough data to classify current regime yet.' })) };
  }

  const evaluated = candidateAgents.map(agent => {
    const blended = getBlendedRegimeEdge(symbol, agent.strategyId, currentRegimeLabel, agent.regimePerformance);
    return { agent, currentRegime: currentRegimeLabel, blended };
  });

  evaluated.sort((a, b) => (b.blended.edge ?? -999) - (a.blended.edge ?? -999));

  const activated = [];
  const rejected = [];
  for (const e of evaluated) {
    const isAppropriate = e.blended.edge != null && e.blended.edge >= minEdgeToAct;
    if (isAppropriate && activated.length < maxAgentsToActivate) {
      activated.push({ ...e, reason: `Activated: ${e.blended.reason} (edge ${e.blended.edge}% in ${currentRegimeLabel})` });
    } else {
      rejected.push({ ...e, reason: e.blended.edge == null
        ? `Skipped: ${e.blended.reason}`
        : `Skipped: edge ${e.blended.edge}% in ${currentRegimeLabel} is below the ${minEdgeToAct}% bar to act — this agent's specialty is elsewhere.` });
    }
  }

  return { currentRegime: currentRegimeLabel, activated, rejected };
}

module.exports = { selectAppropriateAgents, getBlendedRegimeEdge };
