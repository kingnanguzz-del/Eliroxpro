const fs = require('fs');
const path = require('path');

/**
 * No free historical L2/positioning archive exists anywhere — confirmed by
 * research, not assumed. So instead of buying access we can't get for free,
 * we start logging every snapshot the bot ever sees, permanently. A month
 * from now, this file has real history nobody can sell us. A year from
 * now, it's a genuinely valuable dataset unique to this bot.
 *
 * Stored as append-only JSONL on disk (survives restarts, unlike the
 * in-memory paper-trade ledger). Render's disk persists across requests
 * during uptime; back this up periodically if you want to survive a
 * full redeploy wipe (Render's free tier disk is NOT guaranteed durable
 * across deploys — export it occasionally via the API if it matters to you).
 */
const MEMORY_DIR = path.join(__dirname, '..', '..', 'memory_data');
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });

function memoryFilePath(symbol, sourceType) {
  const safe = symbol.replace('/', '_');
  return path.join(MEMORY_DIR, `${sourceType}_${safe}.jsonl`);
}

/**
 * Appends one snapshot. sourceType is 'crypto_orderbook' or 'forex_positioning'
 * so the two data types (real L2 imbalance vs retail positioning sentiment)
 * never get confused with each other downstream.
 */
function logSnapshot(symbol, sourceType, snapshot) {
  const filePath = memoryFilePath(symbol, sourceType);
  const line = JSON.stringify({ time: Date.now(), ...snapshot }) + '\n';
  fs.appendFileSync(filePath, line);
}

/**
 * Reads back accumulated history for a symbol/source, most recent last.
 * Returns [] if nothing logged yet (honest — there's no history until we
 * build it, no pretending otherwise).
 */
function readHistory(symbol, sourceType, maxEntries = 500) {
  const filePath = memoryFilePath(symbol, sourceType);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const recent = lines.slice(-maxEntries);
  return recent.map(l => JSON.parse(l));
}

/**
 * Derives rolling stats from OUR OWN accumulated history — this is what
 * turns single noisy snapshots into a genuine memory-informed signal.
 * Returns null if we don't have enough history yet (honest about the
 * cold-start: on day one, there is no memory yet, and that's expected).
 */
function getMemoryStats(symbol, sourceType, windowSize = 20) {
  const history = readHistory(symbol, sourceType, windowSize);
  if (history.length < 5) {
    return { available: false, entriesLogged: history.length, reason: 'not enough history accumulated yet — check back after more sessions' };
  }

  const imbalances = history.map(h => h.imbalance);
  const mean = imbalances.reduce((a, b) => a + b, 0) / imbalances.length;
  const recent = imbalances.slice(-5);
  const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const trend = recentMean - mean; // positive = imbalance increasing (more buy pressure building)

  return {
    available: true,
    entriesLogged: history.length,
    meanImbalance: +mean.toFixed(4),
    recentMeanImbalance: +recentMean.toFixed(4),
    trend: +trend.toFixed(4),
    trendDirection: trend > 0.02 ? 'building_buy_pressure' : trend < -0.02 ? 'building_sell_pressure' : 'stable'
  };
}

/**
 * Tracks trades the bot SKIPPED due to the order book veto, then later
 * checks what price actually did — so if the veto keeps being wrong
 * (price would have won anyway), the bot learns that and starts taking
 * a smaller, cautious version of that same setup instead of skipping
 * blindly forever.
 */
function logVetoedSignal(symbol, vetoRecord) {
  const filePath = memoryFilePath(symbol, 'vetoed_trades');
  const line = JSON.stringify({ time: Date.now(), resolved: false, ...vetoRecord }) + '\n';
  fs.appendFileSync(filePath, line);
}

/**
 * Re-reads all vetoed trades, resolves any that are old enough to judge
 * (currentPrice known, enough time passed), and rewrites the file with
 * resolutions filled in. Returns the overturn rate — how often the veto
 * was actually wrong — so the caller can decide whether to start
 * cautiously overriding it.
 */
function resolveVetoedSignals(symbol, currentPrice, now, horizonMs, targetPct) {
  const filePath = memoryFilePath(symbol, 'vetoed_trades');
  if (!fs.existsSync(filePath)) return { overturnRate: null, sampleSize: 0 };

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const records = lines.map(l => JSON.parse(l));

  for (const r of records) {
    if (r.resolved) continue;
    if (now - r.time < horizonMs) continue; // not mature yet
    const movePct = ((currentPrice - r.entryPrice) / r.entryPrice) * 100;
    r.resolved = true;
    r.wouldHaveWon = movePct >= targetPct; // the veto blocked a "long" — would it have hit target?
    r.actualMovePct = +movePct.toFixed(3);
  }

  fs.writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');

  const resolved = records.filter(r => r.resolved);
  if (resolved.length < 10) {
    return { overturnRate: null, sampleSize: resolved.length, reason: 'need at least 10 resolved vetoes to judge a pattern' };
  }
  const wins = resolved.filter(r => r.wouldHaveWon).length;
  return { overturnRate: +((wins / resolved.length) * 100).toFixed(1), sampleSize: resolved.length };
}

module.exports = { logSnapshot, readHistory, getMemoryStats, logVetoedSignal, resolveVetoedSignals };
