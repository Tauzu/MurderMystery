import { defineConfig } from 'vitest/config';

// 実DB・パスワードのハッシュ化を使うテストが、他のテストと並行すると5秒を超えることがある
export default defineConfig({ test: { testTimeout: 20_000 } });
