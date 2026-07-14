const { rsi, macd, cci, ema, atr } = require('../indicators');
const { findRateAtTime } = require('../data/fundingRate');

/**
 * Builds a feature matrix + labels from candle history.
 * Each row = features known AT candle i (no lookahead).
 * Label = did price move up by more than `targetPct` within `horizon` candles?
 * (binary classification: 1 = target hit, 0 = not)
 */
function buildDataset(candles, opts = {}) {
  const { horizon = 5, targetPct = 0.5, newsFlags = null, carryDifferential = null, fundingRateHistory = null } = opts;
  const closes = candles.map(c => c.close);

  const rsiArr = rsi(candles, 14);
  const macdRes = macd(candles, 12, 26, 9);
  const cciArr = cci(candles, 20);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atrArr = atr(candles, 14);

  const rows = [];
  const warmup = 60;

  for (let i = warmup; i < candles.length - horizon; i++) {
    if (rsiArr[i] == null || macdRes.histogram[i] == null || cciArr[i] == null ||
        ema20[i] == null || ema50[i] == null || atrArr[i] == null) continue;

    const avgClose = closes.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;
    const atrPct = (atrArr[i] / avgClose) * 100;
    const trendUp = ema20[i] > ema50[i] ? 1 : 0;
    const macdHistPrev = macdRes.histogram[i - 1] ?? 0;
    const macdRising = macdRes.histogram[i] > macdHistPrev ? 1 : 0;
    const newsFlag = newsFlags ? (newsFlags[i] ? 1 : 0) : 0;
    // Carry: real fundamental signal (rate differential), same value every
    // row for a given symbol since policy rates don't change candle-to-candle.
    // Squashed to -1..1; null (e.g. crypto pairs with no rate data) becomes 0.
    const carryFeature = carryDifferential != null ? Math.tanh(carryDifferential / 5) : 0;
    // Funding rate: real history exists (Kraken), so this is a legitimate
    // trained feature — unlike order book imbalance, which is live-only.
    const rawFundingRate = fundingRateHistory ? findRateAtTime(fundingRateHistory, candles[i].closeTime) : null;
    const fundingFeature = rawFundingRate != null ? Math.tanh(rawFundingRate * 1000) : 0;

    // Future label: max favorable move within horizon candles
    let maxUp = -Infinity;
    for (let h = 1; h <= horizon; h++) {
      const futurePct = ((closes[i + h] - closes[i]) / closes[i]) * 100;
      if (futurePct > maxUp) maxUp = futurePct;
    }
    const label = maxUp >= targetPct ? 1 : 0;

    rows.push({
      features: [
        rsiArr[i] / 100,             // normalize 0-1
        Math.tanh(macdRes.histogram[i] * 10), // squash to -1..1
        Math.max(-1, Math.min(1, cciArr[i] / 200)), // clip
        trendUp,
        macdRising,
        Math.min(1, atrPct / 3),     // normalize volatility
        newsFlag,
        carryFeature,
        fundingFeature
      ],
      label,
      index: i,
      closeTime: candles[i].closeTime
    });
  }

  return rows;
}

const FEATURE_NAMES = ['rsi_norm', 'macd_hist_squashed', 'cci_clipped', 'ema_trend_up', 'macd_rising', 'atr_pct_norm', 'near_news_event', 'carry_differential', 'funding_rate'];

module.exports = { buildDataset, FEATURE_NAMES };
