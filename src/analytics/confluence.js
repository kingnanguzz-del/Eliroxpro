const { rsi, macd, cci, ema, atr } = require('../indicators');

function scoreLatest(candles) {
  if (candles.length < 60) {
    throw new Error('Need at least 60 candles for reliable scoring');
  }

  const closes = candles.map(c => c.close);
  const i = candles.length - 1;

  const rsiArr = rsi(candles, 14);
  const macdRes = macd(candles, 12, 26, 9);
  const cciArr = cci(candles, 20);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atrArr = atr(candles, 14);

  const breakdown = [];
  let bullScore = 0;
  let bearScore = 0;

  const rsiVal = rsiArr[i];
  if (rsiVal != null) {
    if (rsiVal < 30) { bullScore += 20; breakdown.push({ signal: 'RSI', reading: rsiVal.toFixed(1), bias: 'bullish', reason: 'oversold (<30)' }); }
    else if (rsiVal > 70) { bearScore += 20; breakdown.push({ signal: 'RSI', reading: rsiVal.toFixed(1), bias: 'bearish', reason: 'overbought (>70)' }); }
    else breakdown.push({ signal: 'RSI', reading: rsiVal.toFixed(1), bias: 'neutral', reason: 'mid-range' });
  }

  const hist = macdRes.histogram[i];
  const prevHist = macdRes.histogram[i - 1];
  if (hist != null && prevHist != null) {
    if (hist > 0 && hist > prevHist) { bullScore += 25; breakdown.push({ signal: 'MACD', reading: hist.toFixed(4), bias: 'bullish', reason: 'histogram positive & rising' }); }
    else if (hist < 0 && hist < prevHist) { bearScore += 25; breakdown.push({ signal: 'MACD', reading: hist.toFixed(4), bias: 'bearish', reason: 'histogram negative & falling' }); }
    else breakdown.push({ signal: 'MACD', reading: hist.toFixed(4), bias: 'neutral', reason: 'momentum stalling' });
  }

  const cciVal = cciArr[i];
  if (cciVal != null) {
    if (cciVal < -100) { bullScore += 20; breakdown.push({ signal: 'CCI', reading: cciVal.toFixed(1), bias: 'bullish', reason: 'oversold (<-100)' }); }
    else if (cciVal > 100) { bearScore += 20; breakdown.push({ signal: 'CCI', reading: cciVal.toFixed(1), bias: 'bearish', reason: 'overbought (>100)' }); }
    else breakdown.push({ signal: 'CCI', reading: cciVal.toFixed(1), bias: 'neutral', reason: 'mid-range' });
  }

  if (ema20[i] != null && ema50[i] != null) {
    if (ema20[i] > ema50[i]) { bullScore += 20; breakdown.push({ signal: 'Trend', reading: 'EMA20>EMA50', bias: 'bullish', reason: 'uptrend structure' }); }
    else { bearScore += 20; breakdown.push({ signal: 'Trend', reading: 'EMA20<EMA50', bias: 'bearish', reason: 'downtrend structure' }); }
  }

  const atrVal = atr(candles, 14)[i];
  const avgClose = closes.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;
  const atrPct = atrVal != null ? (atrVal / avgClose) * 100 : null;
  let volatilityNote = 'normal';
  let volatilityPenalty = 0;
  if (atrPct != null) {
    if (atrPct > 3) { volatilityNote = 'high volatility — widen stops, reduce size'; volatilityPenalty = 10; }
    else if (atrPct < 0.3) { volatilityNote = 'very low volatility — signals less reliable'; volatilityPenalty = 10; }
  }

  const rawScore = Math.max(bullScore, bearScore);
  const finalScore = Math.max(0, rawScore - volatilityPenalty);
  const direction = bullScore === bearScore ? 'neutral' : (bullScore > bearScore ? 'bullish' : 'bearish');

  return {
    score: finalScore,
    direction,
    breakdown,
    volatility: { atrPercent: atrPct != null ? atrPct.toFixed(2) : null, note: volatilityNote },
    recommendation: finalScore >= 65 ? 'strong signal' : finalScore >= 40 ? 'weak signal' : 'no trade — insufficient confluence'
  };
}

module.exports = { scoreLatest };
