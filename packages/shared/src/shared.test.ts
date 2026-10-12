import { describe, expect, it } from 'vitest';
import { CARDS_PER_CHARACTER, CONFIG, PHASES, SEAT_COUNT, SET_COUNT } from './index';

describe('shared', () => {
  it('無操作の警告は切替より前に出る', () => {
    expect(CONFIG.IDLE_WARN_SEC).toBeLessThan(CONFIG.IDLE_SWITCH_SEC);
  });

  it('手札は全員で 席数×枚数 枚、公開は セット数×席数 枚で、1人1枚が残る', () => {
    const total = SEAT_COUNT * CARDS_PER_CHARACTER;
    const revealed = SET_COUNT * SEAT_COUNT;
    expect(total - revealed).toBe(SEAT_COUNT);
  });

  it('フェーズは WAITING で始まり CLOSED で終わる', () => {
    expect(PHASES[0]).toBe('WAITING');
    expect(PHASES[PHASES.length - 1]).toBe('CLOSED');
  });
});
