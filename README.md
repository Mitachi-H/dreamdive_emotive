# Emotiv Cortex Realtime Dashboard (Template)

このリポジトリは Emotiv の Cortex API から取得したデータをリアルタイム可視化するための、公開用の雛形です。機密情報を含めない構成と手順を用意しています。

参考: https://emotiv.gitbook.io/cortex-api

## 構成概要

- `server/`: Cortex API と接続する Node.js サーバ (WebSocket/HTTP)。静的ファイル (`web/`) も配信。
- `web/`: 最小限のダッシュボードのプレースホルダ (純粋な HTML/JS)。
- `docs/`: アーキテクチャ概要や注意点。

公開リポジトリのため、認証情報や個人データはコミットしない方針です。実値は `.env` に配置し、`.gitignore` で除外しています。

## 使い方 (開発)

前提:
- Node.js >= 18
- Emotiv App が稼働しており、Cortex API (通常 `wss://localhost:6868`) に接続可能

手順:
1. 依存インストール
   - `cd server && npm install`
2. 環境変数の設定
   - `cp server/.env.example server/.env`
   - `server/.env` を編集し、`CORTEX_CLIENT_ID` / `CORTEX_CLIENT_SECRET` 等を設定。
   - 既定では `AUTO_CONNECT=false` です。動作確認後に `true` に変更してください。
3. サーバ起動
   - `npm run start` (server ディレクトリ内)
   - もしくは、リポジトリ直下で: `npm --prefix server run start`
   - ブラウザで `http://localhost:3000` にアクセス

注意: `wss://localhost:6868` は自己署名証明書です。開発目的に限り `NODE_TLS_REJECT_UNAUTHORIZED=0` を `.env` に設定できますが、本番では利用しないでください。

## セキュリティと公開上の注意

- `.env` や機密情報はコミットしない (このテンプレートでは `.gitignore` 済み)。
- リポジトリに鍵・トークン・生データ (EEG 等) を含めない。
- 認証情報は必ず環境変数から読み込む。
- Issue/PR のログにも実データや秘密情報を書かない。

詳細は `SECURITY.md` と `docs/ARCHITECTURE.md` を参照。

## 次の拡張例

- React やチャートライブラリによる UI 強化
- Socket.IO や SSE でのストリーミング実装
- データ保存層 (暗号化 + アクセス制御)
- CI によるシークレットスキャン導入
