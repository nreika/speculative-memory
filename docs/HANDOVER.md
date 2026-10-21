# 引き継ぎメモ（Speculative Memory）

最終更新: 2026-10-21 夜。別アカウントの Claude Code が、メモリ・会話履歴なしで作業を引き継ぐためのメモ。最初に全部読む。
このリポジトリは GitHub で公開（public）。秘密・個人が写った画像は絶対にコミットしない。
古い経緯（TouchDesigner 時代など）は末尾の「付録: 過去の経緯」にまとめた。旧版は git 履歴にある。

---

## 1. 最初に必ず守ること

これらはユーザーが何度も怒った件から来ている。例外なし。

### 進め方
1. **確認するのは次の4つだけ**: 削除、コミット、公開（push・Funnel・共有）、課金が走る実行。それ以外は決めて、実行して、報告する。「許可聞きすぎ」と言われた。推奨案を選んで進める。
2. **課金 API は使わない**（Gemini など）。いまの構成は全部ローカル（ComfyUI + Ollama）。`GEMINI_API_KEY` が `.env.local` にあっても呼ばない。課金が走る処理を無目的に回さない。課金が実際に起きたときだけ金額を報告する。
3. ユーザーが止めたものは、ユーザーが再開を言うまで動かさない。

### サーバー操作
4. Node サーバー・ComfyUI・Ollama の再起動は、確認なしでやってよい。ただし **Node は必ず `scripts/safe-restart.ps1` で**行う（手で kill しない）。
5. **再起動したら必ず新しい PID と開始時刻を `Get-CimInstance Win32_Process` で確認する**。「再起動した」と報告したのに実は起きていなかった件で、丸一日混乱した。確認前に「反映された」と言わない。
6. 入力選択（input select）が pending の間、およびオペレーターが入力を変えて2分以内は再起動しない。再起動は撮影の合間だけ（スクリプトも撮影中は拒否する）。
7. テストの `/api/generate` POST は必ず `test:true` を付ける（本番の画面に出ないため）。
8. **git は常に `git -c maintenance.auto=false -c gc.auto=0 ...`**（.git に緩いオブジェクトが多く、自動整理で固まる）。

### 公開リポジトリのルール
9. コミットしない物: `.env.local`（APIキー・パスワード）、`captures/`、`logs/`、録画（*.mov）、人が写った写真。データは `C:\Users\nmrei\GitHub\speculative-memory_data` に置く（リポジトリの外）。
10. 秘密（キー・トークン・パスワード・`PUBLIC_*` の値）を画面・ログ・報告に出さない。`.env.local` はキー名だけ見る。個人名・個人の IP も書かない。
11. 壊れた画像（人や腕が重複、顔が崩れた、構図がずれた）を公開しない。検査で落とし、再試行し、だめなら NOW のコピーを出す。

### 生成の考え方（ユーザーが決めたこと）
12. **人物ルール**: 生成画像に人が出てよいのは、直近（約10分以内）に部屋にいた人だけ。出すならその人本人。正面フレームがなければ後ろ姿。**見知らぬ人を作らない**。無人の部屋は自然な状態であり、無人のままでよい。直近の人物が出るかどうかは Presence が決める。遠い人・端の人・後ろ向きの人には顔参照を使わない。
13. 直近の映像にある**物**は出てよい。持っていた物は手放してよい。物の重複は禁止。
14. **Tone** = 大きいが日常の動き。芝居がかった動きにしない。**Presence** = どれだけ存在するか（0 = 無人の部屋 … 1 = 中央）。時間距離（±N 秒）が大きいほど変化も大きくする。
15. 画面に出る文章（プロンプト、キャプション、状況・履歴のテキスト）は**日本語**。UI の枠（ボタン名など）は英語。
16. 展覧会を意味する語（ユーザーが禁止した語）は使わない。「作品」「画面」「Auto の生成」と言う。

### 確認の仕方
17. **自分の目で確かめる前に「反映された」「直った」と言わない。** 実際の画面（スクリーンショット）、アーカイブされたプロンプト、生成 PNG を自分で見る。サブエージェントの報告も鵜呑みにしない。
18. 生成された人物を「勝手に作った人」と判断する前に、直近10分のキャプチャ画像を確認する（本当にいた人かもしれない）。
19. 自律で回すときは、QA ループ（プロンプトと画像を読む）を回し続ける。

### 並列作業
20. サブエージェントを並列で使い、モデルは作業ごとに選ぶ（難しい設計だけ重いモデル、機械的な作業は軽いモデル）。メインのスレッドはいつでもユーザーに返事できるようにしておく。
21. **同じファイルを2つのエージェントに触らせない。**
22. 入力やマッピングを試すエージェントは、終わったら必ず元に戻す。**シナリオが画面レイアウトを持っている間は、実際の出力に触らない。**
23. ユーザーは、途中経過の説明、中間報告、正直な失敗報告を求める。黙って長く作業しない。

---

## 2. 構成

```
ノートPC（カメラ入力 + 状況認識）          メインPC emergent-2（生成 + 配信）
  native_input.py :8767  ── カメラ ───────▶ Node サーバー :3000（scripts/server-bootstrap.mjs）
  MJPEG プレビュー                          ComfyUI（turbo）:8001
  Ollama qwen3-vl:4b :11434 ◀── 状況認識 ── 公開ゲート :3443
                                              └ Tailscale Funnel → https://emergent-2.taila81ee8.ts.net
```

### メインPC（emergent-2）
- **Node :3000**: `scripts/server-bootstrap.mjs` が `server.ts` を起動する。キャプチャ、生成、検査、保存、配信、Control 画面、シナリオ実行を全部担当。ログは `logs/server.log`、`logs/server.err.log`。
- **ComfyUI :8001**（turbo）: モデル `qwen_image_2.1_turbo_int8`、8 steps、cfg 1。実験フォルダ `C:\Users\nmrei\claude-code\qwen21-turbo-lab\`（`launch-comfy8001.ps1`）。ComfyUI Desktop の :8000 は使わない・自動起動もしない。
- **公開ゲート :3443**: Node と同じプロセス内の第2サーバー（`server/publicGate/`）。許可リスト方式で :3000 に中継する。Funnel は :3443 だけ。**:3000 を Funnel に出さない。**
- RTX 4090 24GB。ComfyUI は VRAM を使うので、重いローカル LLM を同時に動かさない。

### ノートPC
- **カメラブリッジ** `native_input.py` :8767（Tailscale 経由）。カメラ映像と MJPEG プレビューを出す。コードはノート側にある（このリポジトリにはない）。トークンはノート側とメインの private 設定にあり、リポジトリに書かない。
- **Ollama** :11434、モデル `qwen3-vl:4b`。メインからだけ受信を許可。呼び出しは `think:false`（付けないと思考で上限に達し回答が空になる）。
- 起動アイコンとログオン自動起動の手順は `docs/LAPTOP-LAUNCHER.md`（メインは対応済み。ノート側の対応状況はノートで確認すること）。

### .env.local のキー名（値は見ない・書かない）
`GENERATION_BACKEND`（local）, `COMFYUI_URL`, `COMFYUI_*`, `OLLAMA_URL`, `VLM_MODEL`, `OLLAMA_KEEP_ALIVE`, `QA_ENABLED`, `PUBLIC_BASE_URL`, `GENERATION_ARCHIVE_DIR`, `REF_FRAMES_*`, `TURBO_*`, `BROWSER_DISPLAY_*`, `OPERATOR_RUNTIME`, `OPERATOR_CONTROL_DIRECTORY`, `TD_CONTROL_*`, `PUBLIC_OUTPUT_PASSWORD`, `PUBLIC_COOKIE_SECRET`, `PUBLIC_CAPTURE_TOKEN`。
`GEMINI_API_KEY` と `TOUCHDESIGNER_UDP_*` は古い構成の名残（使わない）。

### データフォルダ `C:\Users\nmrei\GitHub\speculative-memory_data`
| 場所 | 中身 |
|---|---|
| `captures_sorted/`, `ref-frames/` | キャプチャ済みの NOW 写真、参照フレーム（人が写る。公開しない） |
| `generations/<日付>/<id>/` | 1回の生成のアーカイブ。`NOW`、`A`、`B`、`C` の画像、`prompts.json`（全プロンプトと検査結果）、`README`（キャプション・状況）。落ちたものは `generations/rejected/` |
| `experiments/` | 実験・QA メモ（例 `qa-watch-2026-10-21.md`） |
| `operator-control/` | `scenarios/`（ライブラリ）、`scenarios/browser-imports/<uuid>/`（取り込んだ CSV）、`input-selection.json`、`state.json`、`scenario-events.jsonl` |
| `sequences/<フォルダ>/` | Fixed sequence の連番画像（例 `demo`） |
| `models/` | `yunet/`（顔検出）, `hand_landmarker.task`, `person-detector/` |
| `test_set/`, `recordings/`, `mobile_shots/` ほか | テスト素材・録画 |

リポジトリ内の `models/yolo/` は実験で、**使っていない**。

---

## 3. 起動と停止

- **デスクトップのショートカット「Speculative Memory」** → `scripts/launch-main.ps1`。動いていない ComfyUI :8001 と Node :3000 だけを起動し、MAIN（`http://127.0.0.1:3000/control/`）を開く。2回押しても安全。ログは `logs/launcher.log`。
- **ログオン時の自動起動**: タスク スケジューラ「SpeculativeMemory ComfyUI 8001」「SpeculativeMemory Node 3000」（`scripts/install-autostart.ps1` で登録。外すのは `uninstall-autostart.ps1`）。Windows にログオンするまでは動かない。
- **Node の再起動**: `powershell -NoProfile -File scripts\safe-restart.ps1`。
  - 撮影中、またはサーバー起動から60秒未満は拒否する。
  - 新プロセスを非表示で起動し、旧 PID を止める。30秒以内にポート 3000 と `/api/capture/status` の応答を確認する。停止時刻・復帰時刻・ダウン秒数を出すので報告に入れる。
  - **その後に自分でも確認する**:
    ```
    Get-NetTCPConnection -State Listen -LocalPort 3000,3443 | % { Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" | select ProcessId,CreationDate }
    ```
    開始時刻が「いま」であること。3000 と 3443 は同じ PID。
- **止める**: `scripts/stop-server.ps1`、またはポート 3000 の PID を停止。ComfyUI は :8001 の PID。
- **起動後の確認**: (1) MAIN が開く。(2) `GET /api/td-control/state`（ヘッダー `X-Control-Request: 1` が必要）が返る。(3) MAIN の INPUT にカメラ映像、Ollama が緑。(4) 画面 screen-1〜4（`/control/screen/screen-N`）が開き、フェードで画像が出る。(5) `logs/server.log` 末尾に `[capture] completed` が出る。
- テスト: `npx tsc --noEmit -p .` と vitest。既知の失敗が2件ある（SSE heartbeat は並列時のみ落ちることがある）。

---

## 4. 画面と URL

すべて `http://127.0.0.1:3000` から。

| 画面 | URL | 内容 |
|---|---|---|
| **MAIN（Control）** | `/control/` | 操作の中心。INPUT、生成の Mode、Presence/Tone/時間距離、シナリオ、各種状態。リンク: Mapping、History、Manual v1.1、Scenario Guide |
| Mapping | `/control/mapping/` | screen-1〜10 に何を出すか（now / a / b / c / actual-past / generated-history / fixed 等）、フェード、ラベル・字幕の切替 |
| History | `/control/history/` | 過去の生成のタイムライン。サムネイル |
| 出力画面 | `/control/screen/screen-N` | 作品として見せる画面。ブラウザで全画面にして使う |
| Manual v1.1 | https://claude.ai/artifact/41AkBzwauWM6fzfchKqodU | オペレーター用マニュアル（Claude の Artifact）。**MAIN がここにリンクしている。内容を複製しない**。版は `docs/versions.json` |
| Scenario Guide | `/control/guide/` | シナリオ CSV の作り方。実体は `scripts/operator-scenario/SCENARIO-AUTHORING-GUIDE.md`（v1.1）。v1.0 も同じページから見られる |
| 外部提出 | `/submit/`、`/submit/guide/` | 外部の人がシナリオ CSV を出す画面（7章） |

Mapping と History はこの形のパス（末尾スラッシュあり）。リンクは `server/tdControl/index.html` にある。

### 出力画面に出るもの
- ラベル例: `A · FUTURE +30s · T1.0 P0.7 · 1 min ago`（場面、時間距離、その場面の Tone と Presence、何分前の生成か）。
- 字幕: 日本語のキャプション（その場面の動き・状況）。
- **ダブルクリックで情報表示のオン/オフ**。
- 画面ごとにフェード設定がある。skip された場面は前の画像のまま（黒に落ちない）。
- 画像が古いまま止まっていないか（stale）は、スクリーンショットで時々見る。

### 公開ゲート（:3443、Funnel 経由）で通る URL
許可リスト以外は 404/405。通るのは次だけ。
- `/control/screen/screen-N`（とその JS/CSS）、`/api/browser-outputs/screen-N`、`POST /api/display-errors`
- `/capture/?token=...`（スマホのカメラ）、`/submit/?token=...`、`/submit/guide/`
- 出力にはパスワード（cookie 12時間）が必要。顔ぼかしがオンの出力はサーバー側でぼかした画像を返す。**ブラウザ側のぼかしは匿名化ではない**。顔検出が失敗したときは原画像を出さない。

---

## 5. 生成パイプライン

1回のキャプチャ（NOW 写真）から A・B（未来）と C（過去）を作る。既定は A=+30秒 / B=+30秒 / C=-30秒。1回で約50〜80秒。

1. **describePeople**（Ollama、毎回）: NOW の人・持ち物・位置・向きを JSON にする。
2. **planScenarios**: 各場面（A/B/C）の動作文と状況文を計画。日本語の字幕と画像用の動作文を作る。
3. **toneEnforce**: Tone に合わない動作（小さすぎ・大きすぎ・芝居がかり）を直す。Tone は場面ごとに設定できる。
4. **composeCoherentEdit**（`server/generation/editPrompt.ts`）: 画像編集用の短いプロンプトを組む（約1k文字）。
   - 動作は**1回だけ**書く。時間距離は1文（span sentence）。Tone 文・Presence 文。
   - 物のルール（出してよい物、重複禁止）。後ろ姿ルール（背中を向けた人は顔を描かない）。
   - **遠い人・端の人・後ろ向きの人には顔参照画像を付けない。**
5. **turbo ComfyUI :8001** で生成（qwen_image_2.1_turbo_int8、8 steps、cfg 1）。cfg 1 なのでネガティブプロンプトは効かない。
6. **検査**（`combinedInspection.ts`、VLM 1回 + CPU）:
   - 人数、`face-on-back`（背中向きの人に顔が出た: YuNet）、body coherence（VLM）、`person_moved` / `person_too_large`、物の重複数、`framing_drift`（構図ずれ: `scripts/frame-align.py`、ORB、CPU）。
   - **`action_not_shown`（動作が見えない）は警告だけ**で落とさない。以前は58〜83%が誤判定で却下していた。持ち物の欠落（missing belongings）も警告。
7. 落ちたら**1回だけ再試行** → だめなら「安全な動作」で再生成 → それもだめなら **NOW のコピー**を出す。
8. 保存: `generations/<日付>/<id>/`（`prompts.json` に全プロンプト・検査・skip 理由、`README` に字幕）。画面へはブラウザの出力ソース経由で配信。

### 無人の部屋・直近人物
- NOW が無人でも、直近10分に人がいたなら、**場面ごとに確率**（設定 `EMPTY-ROOM PERSON`）でその人を**後ろ姿**で描く。確率は `captureId:sceneKey` のハッシュで再現できる。
- 直近の人も物の変化もない場面は **skip**（reason: `no_recent_activity` / `no_movable_object` / `chance`）。skip した場面は前の画面をそのまま残す。
- 無人のままの場面は、光の変化など小さな変化だけ。NOW とほぼ同じ画像になる。
- 実装: `emptyRoomDecision.ts`、`behindViewPlacement.ts`、`personFrame.ts`、`history/testRecentPerson.ts`（テスト入力では人物履歴を別経路で作る）。

### 既知の限界
- 絡まった腕（腕が組み合わさる）は検査をすり抜ける。
- 姿勢推定（YOLO pose など）で腕の検査を試したが、精度が足りず**不採用**。
- Tone を 1 にしても、画像の変化はまだ期待より小さい。
- 無人の部屋では A・B・C の動作文がほぼ同じになる。
- 動作のバリエーションが少ない（同じ「ボトルを胸に」「前に傾く」が繰り返される）。

---

## 6. 入力

MAIN の INPUT で選ぶ。選択の履歴は `logs/server.log` に出る。
- 形式: `[input] <ISO時刻> select queued origin=ui camera` → `[input] ... select origin=queued remote-device -> camera camera#1` → `queued select applied (...)`。
- 起動時は最後の選択（`operator-control/input-selection.json`）を1回だけ再送する（`[input] resync: ...`）。保存がなければ何も選ばない。

| 入力 | 内容 |
|---|---|
| **TSC-001 / 002 / 003** | ノートが再生するテストセット（録画した部屋の連続フレーム）。生成は `test` 扱い。TSC-001 は後半に2人映る |
| **cycle** | 上のセットを順に回す |
| **camera**（ノートのカメラ） | ライブ。ブリッジ `:8767`。カメラ番号を MAIN で選べる。**2026-10-21 夜時点は GOPPA = index 1** |
| **remote-device**（スマホ） | 公開ゲートの `/capture/?token=...` から送る |

### リモートデバイス（スマホ）
- **同時に1台だけ**。画像は5/10/20秒ごとに送られ、メモリに最新1枚だけ持つ。**30秒来なければ stale**。MAIN に「Release device」ボタンがある。
- サーバー再起動後は、フレームが実際に届いたときだけ復元する。
- 止まると MAIN に**赤い通知**が出る。選んだまま放置しない（人物履歴に入るため）。

### カメラ入力の注意
- `framing_drift` が多いときは、カメラが実際に動いていることが多い（2026-10-20 に確認した真陽性）。画角を固定する。
- 頭まで画角に入れる。顔が端で切れると、別人の顔を想像で描く。

---

## 7. シナリオ

シナリオ = CSV のタイムライン。設定変更、プロンプト、画面割り当て、生成のタイミングを決める。
- 形式は **`scripts/operator-scenario/SCENARIO-AUTHORING-GUIDE.md`（v1.1）** が正本。列は `seconds,action,target,value`。コマンド表は guide の3章。ここに複製しない。
- 実装: `scripts/operator-scenario/scenario_csv.py` / `scenario_engine.py`（Python）、`server/operatorScenario.ts`、`server/nativeOperator.ts`。
- ライブラリ: データフォルダの `operator-control/scenarios/`。MAIN で取り込むと `browser-imports/<uuid>/` に保存。例は `scripts/operator-scenario/examples/`。

### SCN-DEFAULT
- A と B は +30秒、C は -30秒。A は Tone 1、B は Tone 0。モード chain（1枚終わったらすぐ次）で連続生成。
- 4画面とも `output_fade original`、screen-4 は C を表示。プロンプトは空（余計な指示なし）。
- 600秒で終わり、`loop true` で最初から繰り返す。止めるまで続く。

### 読み込みとチェック
- Load/Import のとき全行をチェックする。エラーがあれば**何も読み込まない**（前のシナリオが残る）。MAIN に赤い `FORMAT ERROR · N`、警告は黄色い `WARNING · N`、行番号つき。
- 結果は state の `scenario.formatErrors / formatWarnings`。MAIN の **Copy ボタン**でエラーをコピーできる（AI に直させるため）。

### 外部提出
- `/submit/?token=...`（公開ゲート経由）から外部の人が CSV を出せる。実装 `server/scenarioSubmit.ts`、`server/publicGate/submitGate.ts`。
- **承認してから再生する**。承認前は再生しない。

### 画面の持ち主はシナリオ
- シナリオを Play すると、そのシナリオが mapping（画面割り当て）を持つ（`ownsLayout: true`）。
- **手動で Mapping を編集するとシナリオから切り離される（detach）。一時停止にはならない。**
- Fixed sequence: `output_sequence` で `sequences/<フォルダ>` の連番画像を指定画面に流す（`フォルダ|frame_sec|start|end`）。
- Stop / End で、シナリオが変えた設定と画面割り当てを元に戻す。Preview only は表示だけで、生成も設定変更もしない。
- **生成中に Play すると待ち行列に入る**（拒否ではない）。
- 1回の生成に約50〜80秒かかる。手動 `generate` 行は90秒以上あける。

---

## 8. 今日までに直した主な不具合と、残っている課題

### 直したもの（2026-10-20〜21、ブランチ上のコミット）
- **再起動スクリプトの嘘の報告**: 「再起動した」のに起きていなかった。`safe-restart.ps1` を作り直し、PID 確認を必須にした。
- **翻訳の無限再帰**: キャプションの日本語化が無限ループしていたのを修正。
- **背中向きの人に顔が出る**: YuNet の `face-on-back` 検査と `backViewFace.ts`。顔検出器を YuNet に統一（ぼかしも同じ）。
- **プロンプトの作り直し**: 約3,273文字 → 約1.2k文字。同じ指示の繰り返し 363 → 0。動作は1回だけ書く。
- **`action_not_shown` の誤却下**（58〜83%）を警告だけにした。
- 人物の位置・大きさの検査（`person_moved` / `person_too_large`）を追加。
- 無人の部屋の生成、Presence/Tone を場面ごとに設定、時間距離ごとに変化量を変える。
- ライブ MJPEG プレビュー（1秒ポーリングをやめた）、出力を `screen-N` の1系統に統一、外部 CSV 提出、リモートデバイスのロック（1台のみ・30秒 stale・赤い通知）。
- 起動アイコン、ログオン自動起動、ロゴ（`docs/brand/`）。

### 残っている課題
1. 無人の部屋で A・B・C のテキストが同一になる（動作の選び方を分ける）。
2. Tone 1 でも画像の変化が小さい。
3. tailnet 経由の画面で応答が遅い件を調査中。原因はまだ特定していない。
4. 物の重複検査が実際に効いているか（見逃していないか）。
5. 参照画像に「後ろ姿のフレーム」を優先して使う仕組み。
6. 再生（replay）からカメラに切り替えたときの直近人物の動作確認（未検証）。
7. 動作のバリエーションが少ない。
8. `framing_drift` が B で多く skip される（小さな正常な変化まで落としている可能性）。

QA の詳細は `speculative-memory_data\experiments\qa-watch-2026-10-21.md`。

---

## 9. ユーザーとの進め方

- 日本語で、短く。専門用語はかみ砕く。ユーザーが使う語（作品、画面、Auto の生成、Tone、Presence）を使う。
- **途中経過を伝える**。長い作業で黙らない。中間報告を出し、失敗は正直に言う。「できた」は自分で画面や画像を見てから。
- **許可を聞きすぎない**。確認するのは削除・コミット・公開・課金だけ（1章）。
- 一項目ずつユーザーにコマンドを実行させて結果を貼らせない。自分で実行して確かめる。
- よくある不満と対策:

  | 不満 | 対策 |
  |---|---|
  | 「再起動したと言ったのに直っていない」 | safe-restart + Get-CimInstance で PID と時刻を確認して報告 |
  | 「直したと言うが画面で見たのか」 | スクリーンショット・PNG・アーカイブのプロンプトを自分で見る |
  | 「知らない人が出ている」 | 直近10分のキャプチャで確認。いないなら生成の不具合として直す |
  | 「許可聞きすぎ」 | 推奨案を選んで実行、報告 |
  | 「課金が勝手に走っている」 | 課金 API を使わない。ローカルだけ |
  | 「同じテキスト・同じ動きばかり」 | QA で繰り返しを数える（残課題 1, 7） |
- コミットは勝手にしない。push はユーザーが決める。

---

## 10. 直近の状態（引き継ぎ時点: 2026-10-21 19:59 JST ごろ）

- ブランチ: `feat/coherent-prompts-2026-10-21`。最新コミット `9eab0f7`（Empty-room handling, person position checks, live MJPEG preview, external CSV submission, remote-device lock）。
- **未コミットの変更: 50ファイル**（`git status --short`）。`server.ts`、`server/generation/*`、`scripts/operator-scenario/*` など。コミットはユーザーの許可を得てから。
- サーバー: Node :3000 と公開ゲート :3443 は同じ PID **35620**、開始 2026-10-21 19:48:58。ComfyUI :8001 は PID 15156、開始 2026-10-20 15:25。Ollama はノート側が本番の呼び出し先。
- 生成: 実行中（mode chain、interval 70、phase generating）。
- シナリオ: **SCN-DEFAULT** を Play 中（600秒周期の約559秒時点、`ownsLayout: true`）。ライブラリに SCN-SIMPLE-001、SCN-MAPPING-001/002、SCN-SETTINGS-002、SCN-TEST-NOGEN-001、SCN-IMAGE-001 など。
- 入力: ノートのカメラ（index 1）。リモートデバイスの保持者がいて、フレームは fresh（3秒前）。`pendingInput` は無し。
- 設定: Presence 0.73（全体）、B は 0.28、C は 0.39。Tone は全体 0.65、A=1、B=0。EMPTY-ROOM PERSON 0.14。
- 次にやること候補: 8章の残課題。特に 1（同一テキスト）と 2（Tone 1 の効き）。QA ループを回しながら進める。

---

## 付録: 過去の経緯（いまも意味のある事実だけ）

### 構成の変遷
- 最初は TouchDesigner（TD）がカメラ・表示・タイマーを担い、Gemini が状況認識、ComfyUI（Qwen-Image-Edit-2511 の GGUF + Lightning）が画像生成だった。UDP 9989 で TD に通知していた。
- 2026-10-13 ごろ、状況認識をノートの Ollama（qwen3-vl）に移した。2026-10-18 に turbo（qwen_image_2.1_turbo_int8）に切り替え（`docs/TURBO-CUTOVER-2026-10-18.md`）。その後、TD の表示をブラウザの `screen-N` に置き換え、TD は使わなくなった。`touchdesigner/` と `server/tdControl/` の名前に TD の名残がある（`tdControl` は実質 Control 画面の実装）。
- 構成図: `docs/system-architecture.md`、`docs/generation-flow.md`、`docs/MULTI-PC-ARCHITECTURE.md`、`docs/LAPTOP-HANDOFF.md`、`docs/LAPTOP-OLLAMA.md`。

### そう決めた理由（結論だけ）
- 旧構成では GGUF + smart memory ON が最速だった。`--disable-smart-memory` は付けない（3枚が65秒に悪化した）。`--fast`、バッチ化、ステップ削減は効かなかった。
- **ネガティブプロンプトは効かない**（Lightning/turbo は cfg 1）。NAG は Qwen-Image 非対応。だから「出さない」ことはプロンプトと検査で担保する。
- 同じプロンプトで課金を回し続けて無駄にした件（2026-10-03〜06、Gemini 約1,140回）が、「課金を無目的に回さない」「止めたものを勝手に再開しない」の元になっている。Gemini の実測は1キャプチャ約4〜6円だった。いまはローカルのみ。
- ComfyUI は共有物。テストで `/interrupt` を全体に送らない、キューを消さない（個別は `POST /api/jobs/{id}/cancel`）。
- Python の文字化けは `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` で防ぐ（PowerShell 5.1 / cp932）。
- Ollama のモデルは ComfyUI が VRAM を使っている最中に読み込むと CPU にはみ出して遅い。

### ルールの出どころ
- `rulebook/USER_GUIDELINES.md`: ユーザーの指摘を固定制約（G-01 など）にしたもの。**自動改善で変えない・消さない**。変えるときはユーザーに確認し、出典の発言と日付を書く。`rulebook/active.json` が有効版、`docs/RULEBOOK.md` に説明。
- 例: G-01/G-02 = 直近にいた人だけ、後ろ姿で。G-14 = 背面の人物は椅子・持ち物の「横」に置く。G-24/G-25 = 無人場面の人物確率と skip。

### データ・git の扱い
- 9月の作品版（別PC版）は `speculative-memory_demo-sep`（worktree、ブランチ `demo-2026-09`）にあった（現状は未確認）。本番録画とキャプチャ（約13GB）は旧 stash に入り、データフォルダへ取り出し済みだった。**ユーザーが外部にバックアップするまで stash を消さない**（現状の stash は未確認）。
- タグ `pre-tuning-2026-10-03` = 2026-10-03 のチューニング前の状態。
- ディスク C: の空きは約50GB（2026-10-06 時点）。整理候補は `.git` の緩いオブジェクト、未使用のローカル LLM。
- 開発用ローカル LLM（Ollama の gpt-oss:20b など）は ComfyUI と VRAM を同時に使えない。
