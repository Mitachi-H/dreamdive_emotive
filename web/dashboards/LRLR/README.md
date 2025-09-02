# LRLR: Eye + EOG ダッシュボード

目的: Facial Expression の Eye Actions から lookL / lookR を区別せず "look" として統合表示しつつ、Arduino UNO + AD8232 の EOG 波形を同一の時間軸で可視化します。

## 使い方

1) サーバ起動
- `cd server && npm start`
- ブラウザで `http://localhost:3000/dashboards/LRLR` を開く

2) Facial Expression ストリーム
- ヘッダの `Headset ID` を必要に応じて入力
- `Start fac` / `Stop fac` で Emotiv の fac ストリームを開始/停止
  - Eye Actions は lookL / lookR を自動的に "look" へ集約して 1 行表示します

3) Arduino EOG をプッシュ
- 別ターミナルで Python の HTTP プッシャを実行（pyserial が必要）

```
cd python
python3 eog_http_push.py --server http://localhost:3000 \
  --port /dev/tty.usbmodemXXXX --baud 115200 --aref 3.3
```

トークンを有効化している場合は `--token YOUR_TOKEN` を付けてください。

送信形式は `/api/eog/push` に JSON で以下を POST します:

```
{
  "aref": 3.3,
  "samples": [
    { "epoch_ms": 1725190000123, "raw": 512, "lop": 0, "lon": 0 },
    ...
  ]
}
```

サーバは `raw` を 10bit ADC 前提で `v = raw/1023*aref` に変換し、WS で `type: 'eog'` をブロードキャストします。

## 備考

- 時間軸は UNIX 時刻（秒）で揃えます。EOG 側は `epoch_ms` を送るためダッシュボード内で FAC の `payload.time` と整合が取れます。
- EOG 波形の表示窓は 12 秒（`index.js` の `EOG_WINDOW_SEC`）です。必要に応じて変更してください。

