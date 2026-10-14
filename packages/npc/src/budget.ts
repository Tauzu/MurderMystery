/** 1ゲームで使えるAIのトークン予算。設計書 §8.6。 */
export class Budget {
  private used = 0;

  constructor(readonly limit: number) {}

  add(inputTokens: number, outputTokens: number) {
    this.used += inputTokens + outputTokens;
  }

  get usedTokens() {
    return this.used;
  }

  get ratio() {
    return this.used / this.limit;
  }

  /** 80%を超えたら、発言間隔を延ばす */
  get slow() {
    return this.ratio >= 0.8;
  }

  /** 100%に達したら、AIを使わず定型文・ランダム選択だけにする */
  get exhausted() {
    return this.ratio >= 1;
  }
}
