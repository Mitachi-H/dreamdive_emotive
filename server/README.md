# Emotiv Cortex Server (Node/Express)

Emotiv Cortex WebSocket(JSON‑RPC) クライアントと、ローカル Web UI を配信する Express サーバです。`web/` を静的配信し、REST + WebSocket でブラウザへストリームを中継します。

## クイックスタート

1) 依存関係をインストール（初回のみ）

```
cd server
npm install
```

2) 設定を作成

```
cp .env.example .env
# Emotiv Developer の `CORTEX_CLIENT_ID` / `CORTEX_CLIENT_SECRET` を設定
# 開発中に自己署名証明書を許可する場合は .env の
#   NODE_TLS_REJECT_UNAUTHORIZED=0
# をそのまま利用（本番では無効化推奨）
```

3) サーバを起動

```
npm start
# http://localhost:3000 を開く
```

4) 必要に応じてトークンを設定（API/WS 保護）

`.env` に `API_AUTH_TOKEN` を設定すると、HTTP は `Authorization: Bearer <token>`、WebSocket は `?token=<token>` が必須になります。

ブラウザではコンソールで下記を実行してから再読込：

```
localStorage.setItem('dashboard_token', 'YOUR_TOKEN')
```

## 環境変数（`.env`）

- `CORTEX_URL`（既定: `wss://localhost:6868`）
- `CORTEX_CLIENT_ID`, `CORTEX_CLIENT_SECRET`（必須）
- `CORTEX_LICENSE`, `CORTEX_DEBIT`, `CORTEX_PROFILE`（任意）
- `NODE_TLS_REJECT_UNAUTHORIZED` 自己署名を許可する場合は `0`（開発のみ）
- `HOST`（既定: `0.0.0.0`）/ `PORT`（既定: `3000`）
- `AUTO_CONNECT` pow を自動サブスクライブする（既定: `false`）
- `API_AUTH_TOKEN` REST/WS の保護に利用（未設定なら認証不要）

CA を指定する場合は `server/certificates/rootCA.pem` を置くと読み込まれます（任意）。

## 実装構成

- `src/server.js` HTTP/WS サーバ起動、Cortex イベントを WS へブロードキャスト
- `src/app.js` Express ルート（REST/API と HTML 配信）
- `src/cortexClient.js` Cortex(JSON‑RPC) クライアント（接続/認可/セッション/購読）
- `src/config.js` `.env` ローダー + 設定
- `src/utils/auth.js` API/WS のトークン検証

UI は `web/` にあり、`/` で静的配信します（リダイレクト無効）。

## REST API

- `GET /healthz` ヘルスチェック
- `GET /api/authentication` 認証情報の集約（userLogin, authorize 試行, accessRight, userInfo, licenseInfo）
- `POST /api/request-access` Emotiv Launcher で承認要求

ヘッドセット操作：
- `GET /api/headset` 一覧（`queryHeadsets`）
- `POST /api/headset/refresh` デバイス再スキャン（`controlDevice('refresh')`）
- `POST /api/headset/connect` JSON `{ id }` で接続

ストリーム制御：
- `POST /api/stream/pow/start` JSON `{ headsetId? }`（任意）。内部で `ensureReadyForStreams` 実行後 `subscribe(['pow'])`
- `POST /api/stream/pow/stop` `unsubscribe(['pow'])`
- `POST /api/stream/mot/start` JSON `{ headsetId? }` 実行後 `subscribe(['mot'])`
- `POST /api/stream/mot/stop` `unsubscribe(['mot'])`
 
ダッシュボード:
- `GET /api/dashboards` `web/dashboards/*/manifest.json` をスキャンして一覧を返す
  - 返却: `{ ok: true, dashboards: [{ name, title, description, path, icon?, tags? }] }`

レート制限： 60 秒あたり 120 リクエスト（`express-rate-limit`）。

## WebSocket

- エンドポイント: `ws://<host>:<port>/ws`（トークンが有効な場合は `?token=<API_AUTH_TOKEN>` 必須）
- サーバからのメッセージ（JSON / `type` フィールド）：
  - `hello` 初回挨拶
  - `labels` `{ streamName, labels }` サブスクライブ成功時（com/fac を除く）
  - `eeg` Cortex からの EEG 生パケット（互換のためそのまま）
  - `pow` 周波数帯ストリーム
  - `mot` モーションストリーム（四元数/加速度/磁気/ジャイロのいずれか）
  - `dev` デバイス情報
  - `eq` EEG 品質
  - `met` パフォーマンスメトリクス
  - `com` メンタルコマンド
  - `fac` 表情

クライアントは `web/pow.js` / `web/motion.js` が参照する形式に合わせて受信します。

ダッシュボード向けには `web/lib/dashboard-sdk.js` の `wsConnect` を利用してください。

## Cortex 接続フロー（概要）

`ensureReadyForStreams` は次を内包します：

1) WebSocket 接続
2) `hasAccessRight` → 未許可なら `requestAccess`（Launcher 側で承認）
3) `authorize`（Client ID/Secret）
4) `controlDevice('refresh')` → `queryHeadsets` → `connect` 希望 ID or 先頭
5) `createSession`（busy の場合はリトライ）

その後、`subscribe(['pow'|'mot'|...])` を実行。成功時に `new_data_labels` イベントを発火し WS へ `labels` をブロードキャストします。

## 認証（任意）

- REST: `Authorization: Bearer <token>` が必要（`API_AUTH_TOKEN` 設定時）
- WS: `ws://.../ws?token=<token>` が必要（同上）

未設定の場合はどちらも認証不要です。

## cURL 例

```
# pow 開始（ヘッドセット ID を省略可）
curl -X POST http://localhost:3000/api/stream/pow/start -H 'Content-Type: application/json' -d '{"headsetId":"H1"}'

# mot 開始
curl -X POST http://localhost:3000/api/stream/mot/start -H 'Content-Type: application/json' -d '{"headsetId":"H1"}'

# 認証トークンを使う場合
curl -H 'Authorization: Bearer YOUR_TOKEN' http://localhost:3000/api/headset
```

## テスト

Jest によるルート・クライアントのユニットテストを含みます。

```
cd server
npm test
```

- `test/app.test.js` 基本 API の疎通
- `test/headset_pow.test.js` pow の API/ページ
- `test/headset_mot.test.js` mot の API/ページ
- `test/cortex_pow.test.js` pow ラベル・イベント
- `test/cortex_mot.test.js` mot イベント/ラベル

## 注意事項

- 開発用途向けテンプレートです。本番環境では TLS/認証/レート制限などの強化が必要です。
- 自己署名許可（`NODE_TLS_REJECT_UNAUTHORIZED=0`）はローカル開発に限定してください。
