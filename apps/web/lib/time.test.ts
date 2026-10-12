import { describe, expect, it } from 'vitest';
import { backoffMs, formatClock, isFatalClose, secondsLeft } from './time';

describe('secondsLeft', () => {
  it('締め切りが無ければ null', () => {
    expect(secondsLeft(null, 0, 1000)).toBeNull();
  });

  it('切り上げで数え、0 を下回らない', () => {
    expect(secondsLeft(10_000, 0, 9_001)).toBe(1);
    expect(secondsLeft(10_000, 0, 10_000)).toBe(0);
    expect(secondsLeft(10_000, 0, 20_000)).toBe(0);
  });

  it('ブラウザの時計がずれていても、サーバー時刻を基準に数える', () => {
    // サーバーの時計がブラウザより 5 秒進んでいる
    const offset = 5_000;
    expect(secondsLeft(60_000, offset, 50_000)).toBe(5);
  });
});

describe('formatClock', () => {
  it('分:秒の形式にする', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(600)).toBe('10:00');
  });
});

describe('backoffMs / isFatalClose', () => {
  it('再接続の待ち時間は倍々に増え、10秒を超えない', () => {
    expect([0, 1, 2, 3, 4, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });

  it('認可エラーでの切断は再接続しない', () => {
    expect(isFatalClose(4401)).toBe(true);
    expect(isFatalClose(4403)).toBe(true);
    expect(isFatalClose(4404)).toBe(true);
    expect(isFatalClose(1006)).toBe(false);
  });
});
