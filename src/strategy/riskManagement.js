const { atr } = require('../indicators');

/**
 * Fixed-fractional position sizing using ATR as the stop-distance proxy.
 * This is how real risk management works: you don't decide "buy 0.01 BTC"
 * arbitrarily — you decide "I will risk X% of capital on this trade," then
 * size the position so that if the stop is hit, the loss equals exactly
 * that X%. Volatility (ATR) determines how far the stop needs to be, which
 * in turn determines how large a position that risk budget can support.
 *
 * Higher volatility -> wider stop -> SMALLER position for the same risk.
 * This is why "risk assessment" and "position size" are the same
 * calculation, not two separate steps.
 */
function calculatePositionSize(candles, opts = {}) {
  const {
    capital = 1000,
    riskPerTradePct = 1.0,     // % of capital risked per trade
    atrMultiplierForStop = 1.5, // stop = entry -/+ (ATR * this multiplier)
    maxPositionPctOfCapital = 50 // hard cap so one trade can't eat the whole account
  } = opts;

  const atrArr = atr(candles, 14);
  const latestATR = atrArr[atrArr.length - 1];
  const currentPrice = candles[candles.length - 1].close;

  if (latestATR == null || latestATR <= 0) {
    return { error: 'Not enough data to compute volatility-based stop distance.' };
  }

  const stopDistance = latestATR * atrMultiplierForStop;
  const stopDistancePct = (stopDistance / currentPrice) * 100;
  const riskAmount = capital * (riskPerTradePct / 100);

  // Position size in $ such that (positionSize * stopDistancePct/100) == riskAmount
  let positionSizeDollars = riskAmount / (stopDistancePct / 100);
  const maxAllowed = capital * (maxPositionPctOfCapital / 100);
  const cappedByMaxPosition = positionSizeDollars > maxAllowed;
  if (cappedByMaxPosition) positionSizeDollars = maxAllowed;

  const units = positionSizeDollars / currentPrice;
  const actualRiskAmount = cappedByMaxPosition
    ? positionSizeDollars * (stopDistancePct / 100)
    : riskAmount;

  return {
    currentPrice: +currentPrice.toFixed(4),
    atrValue: +latestATR.toFixed(4),
    stopDistancePct: +stopDistancePct.toFixed(2),
    stopLossPrice: +(currentPrice - stopDistance).toFixed(4),
    positionSizeDollars: +positionSizeDollars.toFixed(2),
    positionSizeUnits: +units.toFixed(6),
    riskAmountDollars: +actualRiskAmount.toFixed(2),
    riskPctOfCapital: +((actualRiskAmount / capital) * 100).toFixed(2),
    cappedByMaxPosition
  };
}

module.exports = { calculatePositionSize };
