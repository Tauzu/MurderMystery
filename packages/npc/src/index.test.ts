import { expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

it('パッケージが読み込める', () => {
  expect(PACKAGE_NAME).toBe('@mm/npc');
});
