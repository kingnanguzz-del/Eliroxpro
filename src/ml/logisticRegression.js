/**
 * Simple logistic regression trained via gradient descent.
 * Transparent, inspectable, no black-box dependency.
 */
class LogisticRegression {
  constructor(numFeatures, learningRate = 0.1, l2 = 0.001) {
    this.weights = new Array(numFeatures).fill(0);
    this.bias = 0;
    this.lr = learningRate;
    this.l2 = l2;
  }

  sigmoid(z) {
    return 1 / (1 + Math.exp(-z));
  }

  predictProba(features) {
    let z = this.bias;
    for (let i = 0; i < features.length; i++) z += this.weights[i] * features[i];
    return this.sigmoid(z);
  }

  train(rows, epochs = 300) {
    const n = rows.length;
    if (n === 0) return;
    const numFeatures = rows[0].features.length;

    for (let epoch = 0; epoch < epochs; epoch++) {
      const gradW = new Array(numFeatures).fill(0);
      let gradB = 0;

      for (const row of rows) {
        const pred = this.predictProba(row.features);
        const error = pred - row.label;
        for (let j = 0; j < numFeatures; j++) {
          gradW[j] += error * row.features[j];
        }
        gradB += error;
      }

      for (let j = 0; j < numFeatures; j++) {
        this.weights[j] -= this.lr * (gradW[j] / n + this.l2 * this.weights[j]);
      }
      this.bias -= this.lr * (gradB / n);
    }
  }

  evaluate(rows, threshold = 0.5) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const row of rows) {
      const pred = this.predictProba(row.features) >= threshold ? 1 : 0;
      if (pred === 1 && row.label === 1) tp++;
      else if (pred === 1 && row.label === 0) fp++;
      else if (pred === 0 && row.label === 0) tn++;
      else fn++;
    }
    const total = rows.length;
    const accuracy = total ? (tp + tn) / total : 0;
    const precision = (tp + fp) ? tp / (tp + fp) : 0;
    const recall = (tp + fn) ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) ? (2 * precision * recall) / (precision + recall) : 0;
    const positiveRate = total ? rows.filter(r => r.label === 1).length / total : 0;
    // The REAL baseline: a trivial classifier that always predicts the
    // majority class. Comparing against the raw positive rate (instead of
    // this) is a classic bug that makes an imbalanced dataset look like a
    // finding when the model learned nothing at all.
    const majorityBaselineAccuracy = Math.max(positiveRate, 1 - positiveRate);

    return {
      accuracy: +(accuracy * 100).toFixed(1),
      precision: +(precision * 100).toFixed(1),
      recall: +(recall * 100).toFixed(1),
      f1: +(f1 * 100).toFixed(1),
      positiveRate: +(positiveRate * 100).toFixed(1),
      baseRatePositiveClass: +(majorityBaselineAccuracy * 100).toFixed(1), // majority-class baseline, the fair comparison
      confusionMatrix: { tp, fp, tn, fn },
      sampleSize: total
    };
  }
}

module.exports = { LogisticRegression };
