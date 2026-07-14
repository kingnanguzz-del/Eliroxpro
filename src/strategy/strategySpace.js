/**
 * Generates a strategy search space. Being direct about what this actually
 * is: not 1000 independently-invented "ideas," but systematic variation of
 * the levers we have — feature horizon, target size, model type, and
 * decision threshold. That's what a real quant search space looks like;
 * claiming otherwise would be dressing up parameter search as something
 * more magical than it is.
 */
function generateStrategySpace() {
  const horizons = [3, 5, 8, 12, 20];        // candles ahead to look for the move
  const targetPcts = [0.3, 0.5, 0.75, 1.0, 1.5]; // % move that counts as "hit"
  const modelTypes = ['logistic', 'neural'];
  const decisionThresholds = [0.5, 0.55, 0.6, 0.65, 0.7];
  const hiddenSizes = [4, 8, 16]; // only used when modelType === 'neural'
  const l2Options = [0.0005, 0.005]; // regularization strength

  const strategies = [];
  let id = 0;

  for (const horizon of horizons) {
    for (const targetPct of targetPcts) {
      for (const modelType of modelTypes) {
        for (const decisionThreshold of decisionThresholds) {
          for (const l2 of l2Options) {
            if (modelType === 'logistic') {
              strategies.push({ id: id++, horizon, targetPct, modelType, decisionThreshold, hiddenSize: null, l2 });
            } else {
              for (const hiddenSize of hiddenSizes) {
                strategies.push({ id: id++, horizon, targetPct, modelType, decisionThreshold, hiddenSize, l2 });
              }
            }
          }
        }
      }
    }
  }
  return strategies; // 5*5*2*(5 + 5*3) = 5*5*2*20 = 1000
}

module.exports = { generateStrategySpace };
