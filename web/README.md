# Web UI (Emotiv Dashboard Template)

このフォルダは Express サーバが配信するフロントエンド一式です。`/` のトップページから各機能ページ（Authentication / Headset / pow / motion）へ遷移できます。

## 起動方法

- サーバを起動: `cd server && npm start`
- ブラウザ: `http://localhost:3000`
- API トークンを有効にしている場合は、ブラウザのコンソールで以下を実行してから再読込
  - `localStorage.setItem('dashboard_token', 'YOUR_TOKEN')`

サーバ側 WebSocket は `/ws` で、トークンはクエリ（`?token=...`）として渡されます。`app.js` / 各ページのスクリプトが自動的に付与します。

## ページ構成

- `index.html`
  - ルートのランディング。各ページへのリンクと簡易ログを表示。
- `authentication.html` + `auth.js`
  - 認証状態の取得（`/api/authentication`）と `requestAccess` 操作の UI。
- `headset.html` + `headset.js`
  - ヘッドセット一覧（`/api/headset`）、`refresh` / `connect` 操作の UI。
- `pow.html` + `pow.js` + `pow/`（`grid.js`, `state.js`, `topomap.js`）
  - 周波数帯ストリーム pow を可視化。
  - Start/Stop で `POST /api/stream/pow/start|stop` を呼び、WebSocket で `labels` と `pow` を受信。
  - グリッド（センサー × バンド）、14ch 10-20 系のトポマップを描画。
- `motion.html` + `motion.js` + `motion/viz3d.js`
  - モーションストリーム mot を可視化。
  - Start/Stop で `POST /api/stream/mot/start|stop` を呼び、WebSocket で `labels` と `mot` を受信。
  - 3D ビジュアライゼーション（Canvas）で以下を描画:
    - 前方ベクトル（+Z）と座標軸
    - 加速度ベクトル（ACC）と磁気ベクトル（MAG）＋トレイル
    - ヨー/ピッチ/ロール（四元数がある機種）
  - 操作（ヘッダ下の操作列）:
    - Calibrate: 現在姿勢をゼロ点（相対）に補正
    - Reset: 補正のリセット
    - Mirror: 左右反転（装着時に正面が手前に見える用）
    - Scale: Unit / Auto / Manual（ACC/MAG のスケール差を吸収）
    - ACC/MAG gain: Manual モード時のゲイン
    - |ACC| / |MAG|: 生の大きさを表示

## WebSocket メッセージ

- `labels`（{ streamName, labels }）: サーバがサブスクライブ成功時に送出。UI は列名とインデックスをバインド。
- `pow`（そのままブローカスト）: `pow.js` がグリッド/トポマップを更新。
- `mot`（そのままブローカスト）: `motion.js` が `viz3d` に四元数/ACC/MAG を渡して更新。

## ファイル構成（主要）

- `styles.css`: ページ共通のスタイル（グリッド、ログ、トポマップなど）。
- `app.js`: ルートページ用の簡易ログと WebSocket 接続ロジック。
- `pow/`
  - `state.js`: pow ラベルからセンサー/バンドの派生情報を作成。
  - `grid.js`: センサー × バンドのグリッド DOM を構築/更新。
  - `topomap.js`: 14ch トポマップの補間・描画。
- `motion/`
  - `viz3d.js`: 3D 描画・四元数/ベクトル計算・スケーリング・トレイルを担当（モジュール化）。

## 開発ノート

- 認証トークン: サーバの `API_AUTH_TOKEN` を設定した場合のみ必須。WebSocket/HTTP どちらも `Authorization: Bearer` で送信。
- ラベル依存: pow/mot ともに `labels` メッセージで列名からインデックスを決定。ハードウェア差（INSIGHT/EPOC+ 等）により mot のラベルセット（`Q0–Q3` vs `GYRO*`）が変わります。
- 3D 可視化: `viz3d.js` は四元数が無い場合でも ACC/MAG をデバイス座標のまま描画（方向の動きは確認可能）。投影は簡易パースペクティブです。
- 追加ストリーム: 新規ストリームを追加する場合は pow/motion と同じ構成（HTML/JS とサーバの `/api/stream/<name>/start|stop` + WebSocket broadcast）を踏襲してください。
