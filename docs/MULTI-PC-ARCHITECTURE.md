# 共通基盤と入力・出力の分担

更新: 2026-10-12。ユーザーと合意した設計。接続済み・実装済みという意味ではない。

## 基本の二台構成

| 役割 | PC | 動かすもの |
|---|---|---|
| 共通基盤 | デスクトップ（現在のメインPC） | Node サーバー、ComfyUI、画像生成、生成結果の保存・配信 |
| 状況認識と展示 | GPU搭載ノート | Ollama + Qwen3-VL、カメラ、TouchDesigner、外部4画面 |

ノートの外部4画面への独立出力はユーザー確認済み。Ollama と TD の同時実行性能は未確認。GPUメモリ・認識中の表示フレームレートを実測し、負荷が大きければ状況認識だけを別のGPU搭載ノートへ移す。三台は必須ではない。

```text
入力（当面はノートのTD・カメラ）
  → メインPCのNodeサーバー :3000
      → ノートのOllama :11434 → 状況説明・シナリオ
      → メインPCのComfyUI :8000 → 生成画像
  → 出力先：TDの4画面／将来のスマホ用ブラウザ画面
```

スマホ版は今後の開発対象。同じ生成結果を使い、表示・演出を出力先ごとに変える。入力と出力は別の役割として扱い、スマホカメラ入力は将来の拡張案。現行のUDP通知はTD向けで、スマホブラウザ用の更新通知・閲覧画面は別途設計する。

## Tailscale と GitHub の使い分け

- Tailscale: 稼働中の端末間通信。各端末を同じtailnetへ接続する。
- GitHub: コード・手順書の受け渡し。APIキー、写真、録画、ログ、モデル本体は載せない。
- 写真・生成画像はメインPCで管理。ノートは必要な画像をHTTPで取得する。
- 外部4画面出力はノートから直接行い、Tailscaleは生成依頼・認識依頼・画像・通知を運ぶ。

## 通信先

| 送信元 → 受信先 | 通信 | 用途 |
|---|---|---|
| TDノート → メインPC | TCP 3000 | 生成依頼、画像取得 |
| メインPC → 状況認識ノート（TDノートと同一でもよい） | TCP 11434 | Ollamaへの状況認識依頼 |
| メインPC → TDノート | UDP 9989 | 生成状態・保存完了の通知 |
| メインPC内 | localhost TCP 8000 | Node → ComfyUI |

設定用の実IPはローカルで記録する。Windowsファイアウォールは必要なポートと通信相手に限定する。ComfyUIはNodeからローカル接続するため、作品の連携だけなら8000を他PCに公開する必要はない。

## メインPCの設定案（まだ適用しない）

`.env.local` 内の既存キーを重複させずに更新する。`<...>` は実値に置き換える。

```dotenv
GENERATION_BACKEND=local
COMFYUI_URL=http://127.0.0.1:8000
OLLAMA_URL=http://<状況認識ノートのTailscale IPv4>:11434
VLM_MODEL=qwen3-vl:4b
OLLAMA_KEEP_ALIVE=5m
PUBLIC_BASE_URL=http://<メインPCのTailscale IPv4>:3000
QA_ENABLED=false
```

モデルはノートの実機確認後に決定する。`QA_ENABLED=false` はローカル経路でもGemini品質検査が走る現行実装を止める設定。ノート側の `OLLAMA_KEEP_ALIVE` より、APIリクエストの `keep_alive` が優先されるためメインPC側にも設定する。

TD側は `Serverurl=http://<メインPCのTailscale IPv4>:3000`、`Imagesource=url`、`Notifyhost` は通常空。既存の `TWO-MACHINE-SETUP.md` を参照。TDへのDAT同期とNetworkページ作成は未実施扱いとし、実機で確認する。

## 未確認事項

- ノートはRTX 4060 Laptop GPU・8188 MiB、Qwen3-VL 4Bとのユーザー申告。正確なモデルタグは担当が照合する。Tailscale IPは受領済みで公開資料に含めない。Ollamaへの外部接続はまだ未完了。
- local経路の三つのシナリオ生成、処理時間、TDと同時実行した際の表示。
- `vlmClient.ts` は `num_ctx` 未指定、`num_predict=1024`。必要なら後続作業で調整する。設定だけで品質を保証しない。
- local経路の失敗時にGeminiへ自動復帰しない。スマホ出力は未実装。
- 生成前にユーザーの確認を取る。タイマー撮影は再開しない。

接続の根拠: [Tailscale公式](https://tailscale.com/docs/how-to/connect-to-devices)、[Ollama設定](https://docs.ollama.com/faq)。
