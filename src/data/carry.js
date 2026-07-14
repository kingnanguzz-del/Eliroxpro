/**
 * Interest-rate "carry" — the one genuinely free, genuinely fundamental
 * signal available without a paid data provider. Central bank rates are
 * public, don't change often, and the differential between two currencies'
 * rates is real, structural information (not sentiment, not a proxy).
 *
 * MANUAL UPDATE REQUIRED: these are not fetched live (no good free live
 * source exists for policy rates), so they will drift out of date. Update
 * this file's numbers periodically from each central bank's own site —
 * that's more reliable than trusting a scraped aggregator.
 */
const POLICY_RATES = {
  USD: 4.50, // Federal Reserve
  EUR: 2.25, // ECB
  GBP: 4.00, // Bank of England
  JPY: 0.50, // Bank of Japan
  AUD: 3.85, // RBA
  CAD: 2.75, // Bank of Canada
  CHF: 0.00, // SNB
  NZD: 3.25  // RBNZ
};

/**
 * Returns the rate differential (base - quote) for a pair like "EUR/USD".
 * Positive = base currency pays more to hold than quote currency (carry-positive).
 */
function getCarryDifferential(symbol) {
  const [base, quote] = symbol.toUpperCase().split('/');
  if (!(base in POLICY_RATES) || !(quote in POLICY_RATES)) return null;
  return POLICY_RATES[base] - POLICY_RATES[quote];
}

module.exports = { getCarryDifferential, POLICY_RATES };
