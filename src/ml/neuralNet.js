/**
 * Minimal multi-layer perceptron (1 hidden layer), built from scratch —
 * no paid ML API, fully inspectable. This is what "neural" means here:
 * it can learn curved/interacting decision boundaries that logistic
 * regression (straight lines only) can't, at the cost of being easier
 * to overfit — which is exactly why we still test everything
 * out-of-sample with the same rigor as before.
 */
class NeuralNet {
  constructor(numFeatures, hiddenSize = 8, learningRate = 0.05, l2 = 0.001) {
    this.hiddenSize = hiddenSize;
    this.lr = learningRate;
    this.l2 = l2;
    // Small random init to break symmetry
    this.W1 = Array.from({ length: numFeatures }, () =>
      Array.from({ length: hiddenSize }, () => (Math.random() - 0.5) * 0.5));
    this.b1 = new Array(hiddenSize).fill(0);
    this.W2 = Array.from({ length: hiddenSize }, () => (Math.random() - 0.5) * 0.5);
    this.b2 = 0;
  }

  relu(x) { return Math.max(0, x); }
  reluDeriv(x) { return x > 0 ? 1 : 0; }
  sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

  forward(features) {
    const hiddenRaw = new Array(this.hiddenSize);
    const hidden = new Array(this.hiddenSize);
    for (let h = 0; h < this.hiddenSize; h++) {
      let z = this.b1[h];
      for (let i = 0; i < features.length; i++) z += features[i] * this.W1[i][h];
      hiddenRaw[h] = z;
      hidden[h] = this.relu(z);
    }
    let outZ = this.b2;
    for (let h = 0; h < this.hiddenSize; h++) outZ += hidden[h] * this.W2[h];
    const output = this.sigmoid(outZ);
    return { hiddenRaw, hidden, output };
  }

  predictProba(features) {
    return this.forward(features).output;
  }

  train(rows, epochs = 200) {
    const n = rows.length;
    if (n === 0) return;
    const numFeatures = rows[0].features.length;

    for (let epoch = 0; epoch < epochs; epoch++) {
      const gradW1 = Array.from({ length: numFeatures }, () => new Array(this.hiddenSize).fill(0));
      const gradB1 = new Array(this.hiddenSize).fill(0);
      const gradW2 = new Array(this.hiddenSize).fill(0);
      let gradB2 = 0;

      for (const row of rows) {
        const { hiddenRaw, hidden, output } = this.forward(row.features);
        const error = output - row.label;

        for (let h = 0; h < this.hiddenSize; h++) {
          gradW2[h] += error * hidden[h];
        }
        gradB2 += error;

        for (let h = 0; h < this.hiddenSize; h++) {
          const dHidden = error * this.W2[h] * this.reluDeriv(hiddenRaw[h]);
          for (let i = 0; i < numFeatures; i++) {
            gradW1[i][h] += dHidden * row.features[i];
          }
          gradB1[h] += dHidden;
        }
      }

      for (let h = 0; h < this.hiddenSize; h++) {
        this.W2[h] -= this.lr * (gradW2[h] / n + this.l2 * this.W2[h]);
        this.b1[h] -= this.lr * (gradB1[h] / n);
        for (let i = 0; i < numFeatures; i++) {
          this.W1[i][h] -= this.lr * (gradW1[i][h] / n + this.l2 * this.W1[i][h]);
        }
      }
      this.b2 -= this.lr * (gradB2 / n);
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
    const majorityBaselineAccuracy = Math.max(positiveRate, 1 - positiveRate);

    return {
      accuracy: +(accuracy * 100).toFixed(1),
      precision: +(precision * 100).toFixed(1),
      recall: +(recall * 100).toFixed(1),
      f1: +(f1 * 100).toFixed(1),
      positiveRate: +(positiveRate * 100).toFixed(1),
      baseRatePositiveClass: +(majorityBaselineAccuracy * 100).toFixed(1),
      confusionMatrix: { tp, fp, tn, fn },
      sampleSize: total
    };
  }
}

module.exports = { NeuralNet };
