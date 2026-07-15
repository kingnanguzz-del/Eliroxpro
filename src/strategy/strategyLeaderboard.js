const persistentStore = require('../data/persistentStore');

/**
 * A leaderboard of strategies that have ALREADY passed the full rigor
 * pipeline (FDR correction + walk-forward consistency + significance).
 * This is the actual "maintain previous winning ones" mechanism: entries
 * here are never silently overwritten by a new search — a new candidate
 * only replaces an existing entry if it clears the same validation bar
 * AND scores better, and even then the old one moves to history rather
 * than being deleted outright.
 */
const LEADERBOARD_KEY = 'strategy_leaderboard';

function getLeaderboard() {
  return persistentStore.get(LEADERBOARD_KEY) || { entries: [], history: [] };
}

/**
 * Considers a newly-validated strategy result for the leaderboard. Only
 * accepts it if it passed validation (defensible edge) — everything else
 * is discarded here, exactly like before, just now with a permanent record
 * of what's actually been proven rather than re-discovering it each time.
 */
function considerCandidate(symbol, interval, validatedResult) {
  if (!validatedResult.verdict.startsWith('defensible')) {
    return { accepted: false, reason: 'Did not pass validation — not eligible for the leaderboard.' };
  }

  const board = getLeaderboard();
  const key = `${symbol}_${interval}_${validatedResult.strategyId}`;
  const existingIdx = board.entries.findIndex(e => e.key === key);

  const candidateEntry = {
    key,
    symbol,
    interval,
    strategyId: validatedResult.strategyId,
    strategy: validatedResult.strategy,
    edgeOverBaseline: validatedResult.edgeOverBaseline,
    significance: validatedResult.significance,
    serializedModel: validatedResult.serializedModel,
    validatedAt: Date.now()
  };

  if (existingIdx === -1) {
    board.entries.push(candidateEntry);
    persistentStore.set(LEADERBOARD_KEY, board);
    return { accepted: true, reason: 'New validated strategy added to leaderboard.' };
  }

  const existing = board.entries[existingIdx];
  if (candidateEntry.edgeOverBaseline > existing.edgeOverBaseline) {
    board.history.push({ ...existing, replacedAt: Date.now() }); // old one preserved, not deleted
    board.entries[existingIdx] = candidateEntry;
    persistentStore.set(LEADERBOARD_KEY, board);
    return { accepted: true, reason: `Replaced previous entry (edge ${existing.edgeOverBaseline}% -> ${candidateEntry.edgeOverBaseline}%). Previous version kept in history.` };
  }

  return { accepted: false, reason: `Existing leaderboard entry (edge ${existing.edgeOverBaseline}%) is still as good or better — keeping it.` };
}

function getTopStrategies(limit = 10) {
  const board = getLeaderboard();
  return [...board.entries].sort((a, b) => b.edgeOverBaseline - a.edgeOverBaseline).slice(0, limit);
}

module.exports = { considerCandidate, getLeaderboard, getTopStrategies };
