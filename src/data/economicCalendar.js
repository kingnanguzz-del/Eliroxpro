const axios = require('axios');

const API_KEY = process.env.FINNHUB_API_KEY;

/**
 * Fetches high-impact economic events (rate decisions, NFP, CPI, GDP) between
 * two dates. Returns [] gracefully if no key is set or the call fails —
 * the rest of the app should keep working with newsFlag simply disabled.
 */
async function getHighImpactEvents(fromDate, toDate) {
  if (!API_KEY) {
    console.warn('FINNHUB_API_KEY not set — news overlay disabled, treating all candles as normal.');
    return [];
  }
  try {
    const { data } = await axios.get('https://finnhub.io/api/v1/calendar/economic', {
      params: { from: fromDate, to: toDate, token: API_KEY }
    });
    const events = data.economicCalendar || data.events || [];
    return events
      .filter(e => (e.impact === 'high' || e.impact === 3 || e.impact === 'High'))
      .map(e => ({ time: new Date(e.time || e.date).getTime(), country: e.country, event: e.event }));
  } catch (err) {
    console.warn('Economic calendar fetch failed (may require a paid Finnhub tier now):', err.message);
    return [];
  }
}

/**
 * Given candle timestamps and a list of event timestamps, returns a boolean
 * array flagging candles within `windowMinutes` of any high-impact event.
 */
function flagCandlesNearEvents(candles, events, windowMinutes = 60) {
  const windowMs = windowMinutes * 60 * 1000;
  return candles.map(c => {
    const t = c.closeTime;
    return events.some(e => Math.abs(e.time - t) <= windowMs);
  });
}

module.exports = { getHighImpactEvents, flagCandlesNearEvents };
