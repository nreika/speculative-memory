# 引き継ぎメモ（Claude Code 用）

最終更新: 2026-10-06。別アカウントの Claude で作業を再開するときに、最初にこれを読む。
このリポジトリは **GitHub で公開（public）**。APIキー・録画・個人が写った画像は絶対にコミットしない。

---

## 1. 何を作っているか

固定カメラの1フレームから「起こりうる3つの世界」（未来A・未来B＝30秒後、過去＝30秒前）を生成して並べて見せるインスタレーション。

```
TD（C920カメラで撮影, td_native_capture.py）
  → Node サーバー :3000 /api/generate
  → 状況認識: Gemini（GENERATION_BACKEND=hybrid）※将来はノートPCの Ollama qwen3-vl（=local）
  → 画像生成: ComfyUI :8000 + Qwen-Image-Edit-2511（このPC, RTX 4090 24GB）
  → UDP 9989 で TD に通知 → 3枚そろったらフェードインで表示
```

## 2. 起動と停止

| 対象 | 起動方法 | 注意 |
|---|---|---|
| ComfyUI | **Comfy Desktop アプリから起動** | `comfy.settings.json` の `Comfy.Server.LaunchArgs` は `{}`。**GGUF 使用時に `--disable-smart-memory` を付けると 65秒/3枚に悪化する。絶対に付けない** |
| Node サーバー | 下のコマンドで**独立プロセスとして**起動。ログは `logs/server.log` | Claude のバックグラウンドタスクとして起動すると、時間制限で殺される |
| TouchDesigner | `touchdesigner/ensyutu_part2.toe` を開く（番号付きの最新 `.N.toe` と中身は同一） | Perform モードで起動する設定 |
| TD の MCP | TD 内蔵（ポート 9988）。TD を開き直したら `/mcp` で `touchdesigner` を Reconnect | 操作パネルの変更は**ユーザーの了承を得てから** |

Node サーバーの起動（PowerShell）:
```
$repo='C:\Users\nmrei\GitHub\speculative-memory_0905'
Start-Process "$repo\node_modules\.bin\tsx.cmd" -ArgumentList 'server.ts' -WorkingDirectory $repo -RedirectStandardOutput "$repo\logs\server.log" -RedirectStandardError "$repo\logs\server.err.log" -WindowStyle Hidden
```
停止: ポート3000を持つプロセスを `taskkill /PID <pid> /T /F`。

展示の一時停止: TD の `/project1` Capture ページで `Capturemode` を `manual` に。VRAM を空けるなら ComfyUI に `POST /free {"unload_models":true,"free_memory":true}`。

## 3. いまの設定（.env.local のキー。値は書かない）

`GENERATION_BACKEND=hybrid` / `COMFYUI_URL=http://127.0.0.1:8000` / `COMFYUI_HIRES=false` / `COMFYUI_LIGHTNING=true` / `COMFYUI_GGUF=true` / `GEMINI_API_KEY` / `OLLAMA_URL` / `VLM_MODEL`
コード側の既定: `COMFYUI_CLOCK_EDIT=auto`（時計が写っているときだけ数字を変える）、ポーリング 0.5秒。

TD のキャプチャ設定（/project1 の Capture ページ）: タイマー90秒。タイマーは「毎回必ず撮影して captures/ に保存、生成は空いているときだけ」。連続モード（3枚そろったら次）、手動（キー `1` / ボタン。生成中なら中断してやり直し）。`timer1` は1秒の「心拍」で、判断は `td_native_capture.py` がする。

## 4. 実測値と、そう決めた理由

- 1キャプチャ ≒ Gemini 11〜26秒 + 画像3枚 約42秒（1枚 12.3秒）。3時間で118回、失敗0。TD 同時起動でも RAM に余裕あり
- **GGUF Q4_K_M（12.3GB）+ smart memory ON** が最速。fp8（19.1GB）は CLIP と VRAM に同居できず毎回入れ替えが発生していた（53.3秒→38.1秒/3枚）。fp8 モデルは戻す用に残してある
- 効かなかったもの: `--fast`（fp8 は既定でネイティブ）、プロンプトのバッチ化、デコードのバッチ化、1280×720 で直接生成（0.5秒速いだけで時計の数字が崩れる）、ステップ削減
- 表示は実は **1280×720**（TD が Non-Commercial ライセンスで 1280px 上限）。カメラも C920 を 1280×720 で受ける。生成は 1392×752 のまま
- **ネガティブプロンプトは効いていない**（Lightning は cfg 1.0 必須で、cfg 1 では負側を計算しない）
- NAG は Qwen-Image では無効（コア `NAGuidance` は Qwen のモデルコードが対応する patch を呼ばない。外部ノードも非対応）
- Gemini の料金は Claude のクレジットとは無関係。1キャプチャ 0.3〜0.5円程度の概算

## 5. git の状態

- ブランチ `feat/capture-modes-gguf`（`feat/local-comfyui-qwen` から分岐）に7コミット。**未プッシュ**（プッシュはユーザーが決める）
- タグ `pre-tuning-2026-10-03` = 今回の変更前の状態（戻し方: 設定だけなら .env.local の GGUF/LIGHTNING/HIRES 行を消す）
- `stash@{0}`（2026-09-05, GitHub Desktop 作成）に本番録画とキャプチャ約13GB が入っている。`C:\Users\nmrei\GitHub\speculative-memory_data\` に取り出し・検証済み。**ユーザーが外部にバックアップするまで stash を消さない**
- `.git` に緩いオブジェクトが13GBあり、コミット時に git の自動整理が走って固まることがある。そのときは `git -c maintenance.auto=false -c gc.auto=0 commit ...`

## 6. 作業中だったこと（2026-10-06 時点）

前のセッションのサブエージェントが途中だった可能性がある。**まず `git status` と `git diff` で、未コミットの変更を確認すること。**

1. **腕・人の重複対策（ポジティブプロンプト）**: 画像編集モデルが「元の腕/人を残して新しい位置に描き足す」失敗（腕3本、同じ人が2人）。`gemini-prompts.json` / `server/generation/comfyClient.ts`（QUALITY_SUFFIX）/ `vlmClient.ts` / `promptBuilder.ts` に「腕は2本、動いた腕・人の元の位置は消す」「両腕の最終位置を書く」ルールを追加中。失敗例: `captures/Gen_b_2026-10-05_23-56-37.png`（腕3本、元 `record_2026-10-05_23-55-54.jpg`）、`captures/Gen_a_2026-10-06_00-01-18.png`（同一人物2人、元 `record_2026-10-06_00-00-24.jpg`）。修正前後を6シードずつ比較してから反映する方針
2. 1で足りなければ **`CFGOverride`（ComfyUI 本体のノード）で最初の1ステップだけ cfg 2** を試す（+約1.7秒/枚）。それでもダメなら全体 cfg 1.5（+約20秒/キャプチャ）
3. **Gemini による自動品質検査**: キャプチャ完了ごとに元写真＋3枚を Gemini に判定させ `logs/qa.jsonl` に記録、重大なものを `captures/qa_flagged/` に。`server/qa/imageJudge.ts`、`scripts/qa-summary.ts`（作成中）。判定役は Gemini Flash / Pro / Claude を既知の失敗例で精度比較して決める
4. 3ができたら、**1時間ごとに Claude が qa-summary とフラグ付き画像だけを見て、改良→比較→反映を繰り返す**（ユーザーの依頼:「延々と回して、変な映像があれば改良」）
5. 反映にはサーバーの再起動が必要（上の手順）

## 7. 未決・宿題

- **シャッフル**: Stream Deck のシャッフル（`s`/`h`/`o`/`r`）は `ensyutu_part1.toe` にだけある（`shuffle_exec`: window1〜4 に switch0〜3 をランダム割り当て）。part2 に移植するか未決。part2 の window1 は `fb_composite1`（未来A＋残像）を映している点に注意。part1 は8/28の固定画像を見せる独立ファイルで、生成とはつながっていない
- TD の `ui_root`（FUTURE DISTANCE, PRESENCE, TONE など）は**見出しだけの試作**で、何にも配線されていない
- Perform モードでは操作パネル（/perform）だけが表示され、出力ウィンドウ window1〜4 は閉じている。モニターは現在2台（設定は4台前提）
- 顔が別人になる: カメラの画角で顔が切れていると、モデルが顔を想像で描く。頭まで画面に入れる
- 時計: 時と分だけだと ±30秒で片方は現実と同じ表示になる（秒表示の時計にするかは未決）
- ノートPC の Ollama（qwen3-vl）への切り替え: ノート側で `OLLAMA_HOST=0.0.0.0`、ポート11434開放 → このPCで `OLLAMA_URL=http://<IP>:11434`, `VLM_MODEL=qwen3-vl:4b`, `GENERATION_BACKEND=local`, `OLLAMA_KEEP_ALIVE=5m`
- ディスク C: の空きが約50GB。整理候補: stash 削除後の `.git`（13GB）、未使用の `moondream`/`gemma3`/`deepseek-r1:32b`
- 開発用ローカル LLM（Ollama）: `gpt-oss:20b`, `qwen3-coder:30b`, `deepseek-r1:32b`。VS Code の Continue に登録済み（`~/.continue/config.yaml`）。ComfyUI と VRAM を同時には使えない

## 8. ユーザーとの作業の進め方

- 日本語で、専門用語はかみ砕く。長い作業中も黙らない
- 作業は**バックグラウンドのサブエージェント**に任せ、本体はいつでも返事できるようにする。Claude のクレジットが少ないので、基本は sonnet / haiku、opus は本当に難しい設計だけ
- 計測値は実測で示し、仮説が外れたら率直に訂正する
- TD の変更、プッシュ、データ削除は確認してから

## 9. ハマりどころ

- ComfyUI Desktop の API はポート **8000**（8188 ではない）
- PowerShell 5.1 / cp932 で Python の出力が文字化け・例外 → `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`
- `Start-Process` の引数でパスに空白（`Comfy Desktop`）があるとクォートが必要
- ComfyUI は展示と共有。テストで `/interrupt` を全体に送らない、キューを消さない（個別キャンセルは `POST /api/jobs/{id}/cancel`）
- Ollama のモデルは ComfyUI が VRAM を使っている最中に読み込むと CPU にはみ出して遅い。`deepseek-r1:32b` はコンテキスト 8K で全部 GPU に載る
