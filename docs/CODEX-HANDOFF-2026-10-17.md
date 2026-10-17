# Codex への引き継ぎ（2026-10-17、Claude から）

展示作品「Speculative Memory」の運用・開発を Claude から Codex へ渡すための要点集。ブランチは `feat/capture-modes-gguf`。リポジトリは **GitHub で公開（public）**。詳細は `AGENTS.md`、`docs/HANDOVER.md`（特に「## 0.5」の 2026-10-15/16 追記、新しい順）、`rulebook/USER_GUIDELINES.md`、`docs/MULTI-PC-ARCHITECTURE.md` を読むこと。食い違いがあればコードとログを正とする。

## 1. 一言でいうと

二台構成。

| 役割 | 機材 | 動かすもの |
|---|---|---|
| ノート "msi"（Tailscale 100.77.14.9） | 展示 TD インスタンス | TouchDesigner（`integrated-msi.*.toe`、現行は .26）、C920 カメラ、外部 4 画面、Ollama `qwen3-vl:4b-instruct` |
| デスクトップ "emergent-2"（Tailscale 100.66.171.99） | 共通基盤 | Node サーバー :3000（`tsx server.ts`）、ComfyUI :8000 |

- ComfyUI は Qwen-Image-Edit-2511 Q4_K_M GGUF + Lightning 4 steps、cfg 1.0。ローカルパッチ: `C:\Users\nmrei\Documents\ComfyUI\custom_nodes\ComfyUI-GGUF\ops.py`。ComfyUI に `--disable-smart-memory` を付けない（大幅に遅くなる、AGENTS.md）。
- データ（アーカイブ・参照フレーム・録画）は `C:\Users\nmrei\GitHub\speculative-memory_data` にあり、**リポジトリには絶対に入れない**。
- 通信: TD → デスクトップ TCP 3000、デスクトップ → ノート Ollama TCP 11434、デスクトップ → TD は UDP。サーバーの既定は `TOUCHDESIGNER_UDP_PORT=9989` だが、本番の `.env.local` は 9991（ノートの展示 TD）。宛先の決め方は `server/network/notifyTarget.ts`。
- 注意: AGENTS.md は「TD: `ensyutu_part2.toe` を開く」と書くが古い。現行の展示は上記 `integrated-msi.*.toe`（ノート側）。

## 2. 絶対ルール

AGENTS.md の第0章とユーザーの運用指示から。

- 公開リポジトリ。**API キー・録画・人が写った写真は絶対にコミットしない**。`GEMINI_API_KEY` は表示・ログ出力しない。写真類は `speculative-memory_data` 側。
- git は必ず `git -c maintenance.auto=false -c gc.auto=0 ...`（`.git` に約 13 GB の緩いオブジェクトがあり固まる）。`stash@{0}`（2026-09-05、本番録画とキャプチャ約 13 GB）は**絶対に drop しない**。
- コミット・プッシュはユーザーが実行する（AGENTS.md）。あなたは手順を用意するだけ。
- TD の `Capturemode` を timer / chain にするのは、ユーザーの明示指示があるときだけ。現在は manual。止められたものはユーザーが再開を明示するまで動かさない。
- 課金（Gemini）が走る実行は、目的を確認してから。料金は有料呼び出しが実際に起きたときだけ報告する（毎回は報告しない、2026-10-11 指示）。
- 確認が必要なのは「消す」「コミットする」「公開する」だけ。サーバーの再起動や設定変更（`.env.local` 含む）は聞かずにやってよい（2026-10-15 指示）。ユーザーは「許可聞きすぎ」と言っている。ルールで決められることは自分で判断して、結果を報告する。
- `/api/generate` へのテスト POST には `test:true` を付け、`captureId` は `td-` で始めない（例 `extras-test-…`）。TD に「テスト画像使用中」の赤帯が出る。`latest.json`・履歴・会場サマリーは更新されない。`notify:false` で UDP も止まる。履歴を汚さないため `recordHistory:false` も推奨（AGENTS.md）。
- `rulebook/USER_GUIDELINES.md` の G-xx はユーザー判断の固定制約。自動改善で変更・削除しない。新しいユーザー判断はその都度追記する。
- 人物ルール: 生成画像に人物を出してよいのは「直近 10 分に部屋にいた人」だけで、その人（同じ服・髪、後ろ姿）に限る。知らない人物を作らない（G-01/G-02）。
- 他の報告を鵜呑みにしない。画像・数字は自分で確かめてから伝える。分からないことはうろ覚えで答えず HANDOVER・コード・ログを見る。

## 3. パイプライン

1. TD が `POST /api/generate` を送る。主なフィールド: 画像（dataURL）、`imageCount`、`captureId`、`sceneDistancesSec`（[a,b,c] 符号付き）、`presence`、`tone`、`sceneExtras{gen_a..}`、`vlmBackend`/`imageBackend`、`test`。
2. `describePeople`（Ollama、`peopleDescribe.ts`）が `people[]` と `obstructed` を返す。
3. シナリオ計画（`planScenariosLocal` または Gemini）＋ `scenarioGuard`: 存在しない人物・物の捏造、重複、腕を上げる動作、無人時の扱い、直近人物の「後ろ姿のみ・10 分以内」を検査。
4. `composeEditInstruction`（`rulebook.ts` / `ruleTexts.ts`）が画像用の指示を組む: 無人テンプレート、後ろ姿、手前の物、トーンの "Amount of change" 文。
5. ComfyUI `generateQwenEdit`（`comfyClient.ts`）。image2/image3 は参照フレームまたは切り出し。
6. アーカイブ（`generations/<日付>/<時刻>/`、`prompts.json`、PNG の tEXt）＋ TD へ UDP `capture.saved`（`sceneText`/`nowText`/`distanceSec`/`historySummary`/`extrasStatus`/`obstructed`/`obstructedBy`/`test`/`source`/backends）＋ `logs/capture-events.jsonl`。
7. QA（`server/qa`）: 撮影の合間にローカル Qwen が 3 枚を検査。次の撮影と衝突しないようゲートされ、新しい撮影で中断される。ルールブックの自動改善は、現在の版で 30 撮影を検査するごと。現在は v3（G-14/G-15 を含む）。`rulebook/active.json` を書き換えると次の撮影から版が切り替わる（再起動不要）。

## 4. 主要ファイル

| パス | 役割 |
|---|---|
| `server.ts` | Express 本体、`/api/generate`（`handleGenerate`）、UDP 通知、各 API |
| `server/generation/vlmClient.ts` | Ollama / VLM 呼び出し |
| `server/generation/orchestrator.ts` | 計画〜生成の段取り |
| `server/generation/comfyClient.ts` | ComfyUI ワークフロー（sharpen は `COMFYUI_SHARPEN_ALPHA`） |
| `server/generation/scenarioGuard.ts` | 捏造・重複・腕上げ等のガード |
| `server/generation/peopleDescribe.ts` | 人物検出・遮蔽判定（`DESCRIBE_PROMPT`） |
| `server/generation/sceneExtras.ts` | 追加指示 extras（辞書＋テンプレート） |
| `server/generation/rulebook.ts` / `ruleTexts.ts` | ルールブックと文言（v1 の文言は ruleTexts.ts） |
| `server/generation/spanFix.ts` | 表示文の先頭の時間幅を distanceSec から決定的に直す |
| `server/generation/backends.ts` / `referenceCrop.ts` | backend 選択 / 参照画像の切り出し |
| `server/history/sceneHistory.ts` / `historySummary.ts` / `changePoints.ts` / `refFrames.ts` | 履歴、要約、変化点、参照フレーム |
| `server/events/captureEvents.ts` / `routes.ts` / `viewer.html` / `obstruction.ts` | 構造化ログ、`/logs` ビューア、遮蔽判定 |
| `server/qa/*` | 継続 QA（localJudge, imageJudge, improver, qaService, guidelines, gridDetect） |
| `server/mobile/*` | スマホ版 `/m`（index.html, routes, queue, access, archiveList） |
| `server/presence/*` | 人物検出 `POST /api/detect-person` |
| `server/health/routes.ts` | `GET /api/health` |
| `rulebook/USER_GUIDELINES.md`, `rulebook/rulebook.v<N>.json`, `rulebook/active.json` | ユーザーガイドライン（G-01〜G-15）と版管理 |
| `scripts/safe-restart.ps1` | 安全な再起動 |
| `touchdesigner/td_*.py` | TD の DAT とファイル同期（UTF-8 BOM なし）。展示インスタンスはノート |

- `touchdesigner/*.py` のリポジトリ側が正。TD の MCP（9988）は Codex では使えないので、TD の操作はユーザーに頼む（AGENTS.md）。TD の変更は確認してから。
- ノートとのファイル受け渡しは Taildrop: `tailscale file cp <f> msi:`。ノートからの到着は `C:\Users\nmrei\Downloads`。

## 5. HTTP / UDP インターフェース（server.ts と各 routes.ts で確認済みのもの）

- 撮影: `POST /api/generate`（会場レーン）。`GET /api/capture/status`、`POST /api/capture/cancel`、`GET /api/generation-status`。
- 履歴: `GET /api/history-summary`（`summary`、`obstructedSince` など）、`POST /api/reset-history`（要約も空に、参照フレームを `<dir>/_archive/` へ移動）、`GET /api/action-history`、`GET /api/latest-capture(s)`、`GET /api/usage`（費用）。
- ログ: `GET /logs`（ビューア）、`GET /api/events`、`GET /api/events/:captureId`、`GET /api/events/summary`、`GET /api/events/:captureId/image/:which`、`POST /api/display-log`（TD の表示先）。
- QA / ルールブック: `GET /api/rulebook`、`GET /api/guidelines`、`GET /api/qa`、`GET /api/qa/summary`、`GET /api/qa/proposals`。
- 状態: `GET /api/health`（`server/health/routes.ts`）。
- スマホ: `GET /m`、`GET /api/mobile/captures`、`GET /api/archive-image/:generationId/:file`、`POST /api/mobile/generate`、`GET /api/mobile/job/:id`、`POST /api/mobile/job/:id/cancel`、`GET /api/mobile/status`（接続元 IP が 100.64.0.0/10・127.0.0.1・192.168.0.0/16 のみ。`MOBILE_ALLOWED_CIDRS`）。
- 人物検出: `POST /api/detect-person`。
- UDP: サーバー → TD に `capture.saved`（3 通、A/B/C。同じ `historySummary` を載せる）。
- 注意: `scripts/safe-restart.ps1` は「`/api/health` は無い」というコメントで `/api/usage` を確認に使っている。一方 `server/health/routes.ts` には `/api/health` がある。起動確認はどちらでも可。

## 6. 運用手順

- 再起動は `scripts/safe-restart.ps1` だけで行う。ログ末尾が `[capture] completed|failed|cancelled` でないと拒否する。起動 60 秒未満のサーバーも拒否。30 秒以内にポート 3000 の LISTEN と HTTP 応答を確認し、だめなら 1 回再試行して `logs/server.err.log` を表示する。通常の停止時間は 13〜15 秒。**2026-10-16 21:27 の再起動だけは 135 秒かかった**（最初の起動が LISTEN しなかった。原因は不明）。
- `.env.local` を編集すると自動で再起動がかかる（vite）。撮影の合間にだけ編集する。
- ノートの Ollama に、撮影中に手動スクリプトを当てない。2026-10-16 20:50、手動プローブで describe が 297 秒止まった。
- テスト撮影は短く、間隔を空けてまとめる（テスト中は TD のタイマー撮影が「生成中」扱いで記録のみになる）。
- サーバーと ComfyUI は非表示のコンソールで動く（safe-restart.ps1 / restart-comfyui.ps1 が ShowWindow=0 で起動）。止めるときはスクリプト（stop-server.ps1 等）か taskkill。
- ComfyUI がハングしたら（連続タイムアウト）: サーバーが自動で `scripts/restart-comfyui.ps1` を実行する（`COMFYUI_FAIL_RESTART_AFTER`、既定 2 回。`COMFYUI_AUTO_RESTART=false` で無効）。/logs に赤バナー、`GET /api/health` の `comfyQueue`（待ちが増え続けたらハング）・`autoRestarts`・`comfyAlert`。手動で復旧するときは同じスクリプトを実行（75 秒以内に /queue が応答すれば成功、終了コード 0）。/interrupt と /queue clear ではハングしたジョブは消えない。
- ログ: `logs/server.log`、`logs/server.err.log`、`logs/capture-events.jsonl`、`logs/scene-history.jsonl`、`logs/history-summary.json`、`logs/qa-local.jsonl`、`logs/rulebook-changes.jsonl`。
- 2026-10-16 15:08〜15:19 に、再起動で起動プロセスが無言で落ちて約 10 分止まった事故あり。再起動のたびに停止・復帰時刻と停止秒数を報告する。

## 7. 2026-10-16 に決めたこと・直したこと

- 在室判定: 検出器 OR describe の `people>0` のみで「有人」とする。シーン文だけでは有人にしない（20:15 に存在しない男性が 2 人描かれた件の対処）。
- 履歴要約: 変化点ベース。最後に有人だった区間を永続化する。
- 直近人物: 後ろ姿のみ、同じ服・髪、1 人だけ。位置と縮尺は元のまま（G-12）。髪型・髪色は変えない（G-13）。
- presence の再定義: 高 presence でも「知らない新しい人物」は出さない。トーンは画像プロンプトに "Amount of change" として入れる。DRAMATIC の例から腕を上げる動作を除いた。presence / tone / 有効 presence は capture-events に記録。
- G-14 持ち物を維持、G-15 見えていない顔を新規に描かない。
- 表示文の先頭の時間幅を `distanceSec` から決定的に補正（`spanFix.ts`）。
- カメラ遮蔽検出: `obstructed` / `obstructedBy`、要約の結びに「(カメラが遮られている可能性)」、TD の NOW パネルに赤字。生成は止めない。/logs に「遮蔽?」バッジ。
- ImageSharpen の格子ノイズ: `COMFYUI_SHARPEN_ALPHA=0` で解消（alpha 0.2 が原因だった）。
- スマホ `/m`: 画像の先読み（eager）、差分更新。スマホ撮影は TD に UDP を送らず、アーカイブは 24 時間で自動削除（`MOBILE_RETENTION_HOURS`）。
- 参照フレーム: `REF_FRAMES_ENABLED`（`.env.example` の既定は false。2 枚、10 分、検出器が人を見たフレームのみ）。**同一性への効果は未測定**。16 日 19:30 ごろからカメラが椅子の背もたれで塞がれたため。

## 8. 未完了・注意

- 直近人物の後ろ姿経路の実機確認が未了（誰かが在室して、その後退室する、という状況が要る）。
- 参照フレームの A/B 測定が未了。
- カメラは物理的に椅子の背もたれで塞がれている。動かせば遮蔽ノートは消えるはず（動かしたら確認）。
- 135 秒かかった再起動の原因は不明。
- ルールブックの自動改善はまだ一度も発火していない（各版で 30 件の検査が必要）。表現に関わる変更や 3 項目以上の変更は自動適用されず `logs/qa-proposals/` に提案が出る（ユーザーに聞く）。
- ブリーフでは `scripts/_qa-exp.ts`（実験用、tsc エラーあり）に言及があったが、2026-10-17 時点でそのファイルは存在しない。`npx tsc --noEmit` を実行してエラーの出所を自分で確認すること。
- 未コミットの変更が多い（`git status` は `docs/HANDOVER.md`、`gemini-prompts.json`、`server.ts`、`server/captureManager.ts` ほか）。コミットはユーザーが実行。
- ユーザーの好み: 短く速い返信、日本語で専門用語はかみ砕く、作業は並行で任せる（Codex ではサブエージェントは使えないので順に進める）。主張は必ずログ・画像で確かめる。計測は実測で示し、仮説が外れたら率直に訂正する。

## 9. 確認コマンド

```powershell
cd C:\Users\nmrei\GitHub\speculative-memory_0905
curl.exe -s http://127.0.0.1:3000/api/health
curl.exe -s http://127.0.0.1:3000/api/history-summary
Get-Content logs\server.log -Tail 30
Get-Content logs\capture-events.jsonl -Tail 3
git -c maintenance.auto=false -c gc.auto=0 status -sb
npx tsc --noEmit -p .          # package.json の "lint" も同じ（tsc --noEmit）
# テスト: package.json に test スクリプトは無い。docs/COMMIT-HANDOVER.md の方式
$t = @(Get-ChildItem -Path 'server' -Filter '*.test.ts' -File -Recurse | ForEach-Object { $_.FullName })
.\node_modules\.bin\tsx.cmd --test @t
```

- 型チェックの既知エラーの有無は、実行して確認すること（上記）。
- テスト対象はモジュールごとに増えている（`server/qa`、`server/history`、`server/mobile` など）。COMMIT-HANDOVER.md の一覧は古い可能性があるので、上のように `server` 以下の `*.test.ts` をまとめて渡す。
- ComfyUI は Comfy Desktop から起動（ポート 8000）。Node サーバーは `scripts/start-server-current.ps1`、停止は `scripts/stop-server.ps1`、通常の再起動は `scripts/safe-restart.ps1`。

## 10. 2026-10-17 の追記

- 05:31〜12:38 ComfyUI ハング(ジョブ 1 件がカーネル内で停止、キュー 71 件滞留)。復旧手順は `scripts/restart-comfyui.ps1`。連続タイムアウト 2 回で自動再起動、`/api/health` の comfyQueue / autoRestarts / comfyAlert、UDP `alert`(TD は赤帯表示)。
- ルールブック v9〜v11: G-16(画面に新しい文字・数字・時計・UI を描かない)、G-07 補足(obstructed 時は遮蔽物を含む構図維持、奥の物を手前に出さない、先頭文 obstructedLeadRule)。obstructed 撮影だけ `COMFYUI_OBSTRUCTED_DENOISE`(既定 0.6)。実験は `speculative-memory_data/experiments/obstruct-ab`。
- ノートだけにある設定(Ollama 監視タスク、TD の最新 .toe は integrated-msi.28)は `docs/LAPTOP-HANDOFF.md` 末尾の追記と、ノートの `Documents\SpeculativeMemory-msi\LAPTOP-HANDOVER-CODEX.md` を参照。

## 11. 2026-10-17 午後の状態(14:20 時点、最新)

- **ルールブックは v13**(`GET /api/rulebook`)。v4〜v8 は自動改善(fabricated_object 対策)で付いた版、v9 G-16、v10/v11 G-07 補足(前後関係、遮蔽時の先頭文 `obstructedLeadRule`)、v12 G-17(光条禁止)、v13 G-17 を肯定表現に書き換え(「虹色の線を描かない」と名指しするとモデルが描くため。人物語と同じ逆効果)。
- **遮蔽時の denoise は 0.8**(`COMFYUI_OBSTRUCTED_DENOISE`、14:12 の撮影から)。0.6 では B の貼り付きは消えたが A に虹色の光条が出た。0.8 + v13 で 14:12 以降の A は光条なし、B は貼り付きなし(14:15 の A を目視確認)。通常撮影は denoise 1.0。
- **A/B の実験記録**: `speculative-memory_data/experiments/obstruct-ab/`、スクリプト `scripts/obstruct-ab.ts`(test:true、撮影の合間に 1 枚ずつ)。
- **コンソール窓**: 以前の `safe-restart.ps1` / `restart-comfyui.ps1` は見える cmd 窓を残していた。14:05 に ShowWindow=0(非表示)へ変更済み。次の再起動から窓は出ない。**サーバーと ComfyUI は非表示のコンソールで動くので、止めるときは `scripts/stop-server.ps1` か taskkill**。ComfyUI は Comfy Desktop のウィンドウとは別に `restart-comfyui.ps1` の経路で動いている(Desktop の画面は「停止」表示のままでよい)。
- **git**: da82134(10-15/16 分)と d7e8a9e(10-17 午前分)はコミット済みだが、`git push` は Git Credential Manager の GitHub サインイン待ちで未完了。サインイン後に `git -c maintenance.auto=false -c gc.auto=0 push -u origin feat/capture-modes-gguf`。その後の変更(v12/v13、denoise 0.8、非表示起動、この節)は次のコミットに入れる。
- **ノートのファイル**: `integrated-msi.28_20261017.toe`、`ollama-watchdog.ps1`、`run-hidden.vbs`、`LAPTOP-HANDOFF-append-20261017.md` が `C:\Users\nmrei\Downloads` に届いているが、未反映(このセッションの権限でコピーが拒否された)。`touchdesigner/integrated-msi.28.toe`、`scripts/laptop/`、`docs/LAPTOP-HANDOFF.md` 末尾へ手で入れる。
- **未解決**: カメラは椅子の背もたれで塞がれたまま(20:00 以前から)。遮蔽が解けたら obstructed=false に戻り、denoise 1.0・通常プロンプトに戻る(確認未)。参照フレーム(REF_FRAMES_ENABLED)の効果測定と、直近人物の後ろ姿描画の実機確認は、人が来るまで進まない。QA の自動改善は 30 判定ごとに走る(`logs/rulebook-changes.jsonl`、`/api/rulebook` の changes)。

