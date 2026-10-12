# マーダーミステリー・オンライン

オンライン多人数参加型のブラウザゲーム。ユーザーが投稿したマーダーミステリーを1〜4人で遊べます。人数が足りない席や、途中で操作がなくなった席は、生成AIのNPCが担当します。

## ドキュメント

すべて [`docs/`](docs/) にあります。

| 文書 | 内容 |
|---|---|
| [企画書](docs/企画書.md) | 企画の背景、ゲーム内容、収益化 |
| [計画書](docs/計画書.md) | 開発の進め方、サイクル、検証計画 |
| [仕様書](docs/仕様書.md) | 機能・ルール・画面の詳細 |
| [設計書](docs/設計書.md) | 構成、データ、通信、NPC、API |
| [進捗](docs/進捗.md) | 実装の進捗と作業ログ、Git運用ルール |

## リポジトリ構成

```
apps/web          Next.js（画面）
apps/server       Fastify（REST・WebSocket）
packages/shared   共有の型・定数・設定値・シナリオ入力のスキーマ
packages/game-core  ルーム状態機械（純粋関数）
packages/npc      NPCのプロンプト・行動決定
scenarios/        運営制作シナリオ（JSON）
docs/             ドキュメント
```

## 開発環境のセットアップ

### 必要なもの

| ツール | バージョン | 備考 |
|---|---|---|
| Node.js | 24（`.node-version` 参照。22以上で動作想定） | |
| pnpm | `package.json` の `packageManager` に記載のバージョン | `corepack enable` で自動的に使われる |
| Docker | 最新版 | PostgreSQL・Redis の起動に使用。サーバーのテストも実DB・実Redisに接続するため必要 |
| Git | | |

### 手順

```bash
git clone https://github.com/Tauzu/MurderMystery.git
cd MurderMystery

corepack enable          # pnpm を有効化（未導入の場合）
pnpm install             # 依存関係をインストール

cp .env.example .env     # 環境変数を用意。必要に応じて値を編集
docker compose up -d     # PostgreSQL と Redis を起動

pnpm db:deploy           # マイグレーションを適用
pnpm db:seed             # 運営制作シナリオ（scenarios/*.json）を登録
```

> `pnpm install` で `esbuild` のビルドスクリプトが許可されます（`pnpm-workspace.yaml` の `allowBuilds`）。

### 起動

```bash
pnpm dev:server   # APIサーバー  http://localhost:3001/health
pnpm dev:web      # 画面        http://localhost:3000
```

### 確認コマンド

PRの前に、次がすべて通ることを確認します。CIでも同じものが実行されます。

```bash
pnpm lint
pnpm format:check   # 整形する場合は pnpm format
pnpm typecheck
pnpm test
pnpm build:web
```

## 環境変数

`.env.example` を参照してください。`.env` はコミットしません。AI関連（`ANTHROPIC_API_KEY`）はS3以降で使います。

## 開発の進め方

- 実装は [計画書](docs/計画書.md) のサイクル（S0〜S7）ごとに進めます。
- 作業のたびに [進捗](docs/進捗.md) を更新します。
- ブランチ・コミット・PRのルールは [進捗](docs/進捗.md) の「Git／GitHub運用」を参照してください。

## 画面の動作確認（ブラウザ）

1. `docker compose up -d`、`pnpm db:deploy`、`pnpm db:seed` を済ませ、`pnpm dev:server` と `pnpm dev:web` を起動する。
2. `http://localhost:3000` を開き、アカウントを登録する。
3. 4人で遊ぶ場合は、別々のユーザーとしてログインするため、**シークレットウィンドウやブラウザを分けて**4つ開き、それぞれ登録して「4人で遊ぶ」を選ぶ。
4. 画面は `/api/*` を `API_URL`（既定 `http://localhost:3001`）へ中継する。WebSocket は `NEXT_PUBLIC_WS_URL`（既定 `ws://<ホスト名>:3001/ws`）へ直接つなぐ。サーバーは `WEB_ORIGIN`（既定 `http://localhost:3000`）以外のオリジンからのWebSocket接続を拒否する。
