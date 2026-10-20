# 2026-10-13 の追記（この節が最新）

- メインPCからノートのOllamaへ GET /api/tags の取得に成功。モデルタグは qwen3-vl:4b をメイン側で確認済み。接続IPは公開資料に記載しない。
- ノート担当の報告: Ollama 0.40.3、RTX 4060 Laptop GPU / 8188 MiB、全アドレスで待受、メインPCだけからTCP 11434受信を許可。
- ノート側の実画像テスト報告: think未指定・num_predict=1024では思考で上限に達し回答が空（done_reason=length）。think=falseで7.6秒、VRAMピーク5.3/8.2GB。これらはユーザー提供の実測値で、メイン側からの本番シナリオ生成はまだ未検証。
- 対策: server/generation/vlmClient.ts の /api/generate リクエストにトップレベル think:false を追加。scripts/check-ollama.ps1 も同じ指定に統一。num_predictは1024のまま。空回答・上限到達を模したfetchモックによる回帰テストを追加。
- コード修正は次回サーバー起動時に反映。今回サーバー起動・画像認識・撮影は行わない。TD同時利用時の性能、本番の三シナリオ出力は未検証。

# 2026-10-12 の引き継ぎ

- デスクトップを共通基盤にする。Nodeサーバー、ComfyUI、画像生成、保存・配信を担当。
- 状況認識（Ollama + Qwen3-VL）とTD・カメラ・外部4画面は一台のGPUノートへまとめる構成を基本とし、負荷が大きければ状況認識を三台目へ分ける。
- 外部4画面の独立出力はユーザー確認済み。出力先は固定しない。スマホ用表示を今後追加する。スマホ版はまだ実装していない。
- ノート: Tailscale/Ollama導入済み。ユーザー実行結果はRTX 4060 Laptop GPU、8188 MiB。モデルはQwen3-VL 4Bとの申告（正確なタグは担当が照合）。IPはチャットで受領し、公開資料には記載しない。
- ユーザーは一項目ずつ手動でコマンドを実行し、結果を貼る進め方を望まない。端末側の担当へまとめて引き継ぎ、自動確認・設定を進める。逐次の手動中継を求めない。
- 料金の毎回報告は不要（ユーザー指示）。生成・撮影前の確認は継続する。
- 詳細: docs/MULTI-PC-ARCHITECTURE.md、docs/LAPTOP-HANDOFF.md、docs/LAPTOP-OLLAMA.md。
- 2026-10-12: 型チェックと既存単体テスト53件が通過。推論・撮影・サービス起動は実施していない。ノートへの疎通と実機性能は未確認。
- GitHub受け渡し: docs/COMMIT-HANDOVER.md。コミット/プッシュはユーザー実行。TDの.toeとバックアップは今回のソース受け渡し対象に含めず、別途内容確認後に扱う。

---
# 引き継ぎメモ（Claude Code 用）

> **Codex など Claude 以外で読む場合**: 「TD の MCP」「サブエージェント」「メモリ」は Claude Code 特有の道具で、Codex では該当なし（`AGENTS.md` に対応表あり）。
> それ以外の事実・ルール・手順はそのまま有効。

最終更新: 2026-10-06 03時ごろ。別アカウントの Claude で作業を再開するときに、最初にこれを全部読む。
このリポジトリは **GitHub で公開（public）**。APIキー・録画・個人が写った画像は絶対にコミットしない。

---

## 0. 最初に必ず守ること（ユーザーが強く怒った件）

- **2026-10-03〜10-06、展示を約2.5日（約3,300枚・Gemini 約1,140回）同じプロンプトのまま回し続け、外部課金を無駄にした。** ユーザーは「プロンプトを随時直しながら生成しろ」と指示していた。さらに 10-05 に「タイマーを止めて」と言われたのに、Claude が改良ループ用に**無断で再開**し、古いプロンプトのまま課金を続けた
- ルール:
  1. **ユーザーが止めたものは、ユーザーが再開を明示するまで動かさない。** テストは手動キャプチャ数回だけ撮って止める
  2. 課金や生成が走るものを動かすときは毎回「何のためか／結果を使っているか／いくらかかっているか」を確認。使っていなければ止める
  3. 料金は毎回報告しない（2026-10-11 ユーザー指示）。生成前の確認は続け、料金は必要時のみ伝える。
  4. うろ覚えで答えない。過去の決定・分担はこのメモ・コード・ログを見てから答える
  5. サブエージェントの報告は鵜呑みにしない（料金「数円」→実際89円、などがあった）。画像・数字は自分で確かめてから伝える
- **現在タイマーは停止中（Capturemode = manual）。ユーザーの指示があるまで timer / chain にしない。**

## 0.5 いまの状態（2026-10-06 03時。下の「06時すぎの追記」が最新）
- **2026-10-20 14:5x サーバー全体が遅い（静的画像 4〜12 秒、History のサムネイルが真っ黒）**: inspector でプロファイルしたところ、非アイドル時間のほぼ全てが Vite(chokidar) の lstat/picomatch。`captures/`（24,043 ファイル・21 GB）と logs/ を監視していて、撮影ごとの新規ファイルでクロールが走り event loop を塞いでいた。修正: `server.ts` の createViteServer に `server.watch.ignored`（captures/logs/.local/rulebook/scripts/docs/touchdesigner/tools）。再起動 11 で反映。注意: 以前の「.env.local 変更で vite が自動再起動する」は誤り（middleware モードでは node は再起動しない）。
- **2026-10-19 22:4x ライブカメラへ切り替えると 504 / 「Input bridge returned inconsistent data」**: ブリッジ（native_input.py）は live-camera 時に replay を null ではなく {active:false,setId:null,cycle:false,pendingSet:null} で返すが、`operatorInput.ts` validateState が test-replay 用の厳密検証を適用して拒否 → select が 504、サーバーは replay のまま、生成停止（昼の食い違いも同原因）。修正: live-camera かつ idle な replay オブジェクトは null に正規化して受理（テスト追加）。同時に生成中の input.select を queue する修正（pendingInput、完了直後に適用、Control に Queued… 表示）も同梱。
- **2026-10-19 scenario.play 504（SCN-SETTINGS-002）**: オペレーターの `generation.pause` は仕様どおりシナリオ時計も止める（state=paused）。従来はその後の `scenario.play` が「最初から再開始」で、`play()` の素の Error（'Scenario is updating' 等、statusCode なし）が delegate から出ると operatorState が 504「Command outcome is unconfirmed」に変換していた。
- 修正: `nativeOperator.ts` が generation.pause で止めた印（pausedByHold）を持ち、その状態の `scenario.play` は同じ run を再開して submissionHold=false に戻す（generation.resume 相当、elapsed 保持、再開始しない）。`operatorState.ts` の delegate 戻り値に `submissionHold` を追加。`operatorScenario.ts` の play() の 'Scenario is updating' / 'Load a scenario first' は 409 に。`generation.resume` はシナリオ稼働中は従来どおり 409（再開は scenario.play）。
- テスト: `nativeOperator.test.ts` に 1 件追加（play→generation.pause→scenario.play→running・同一 runId・hold=false）。tsc クリーン、operator 系テスト通過。サーバー未再起動 → 次の再起動で反映。
- **2026-10-19 18:2x 退行と修正**: 再起動 4 直後、無人回が全件 failed（Person identity check failed after 1 attempts）。原因は missing_belongings 検査が describe の小物（blue water bottle）まで対象にし、4B が確認できず毎回不採用。修正: `combinedInspection.ts` の `belongingsList` を `BELONGING_WORDS`（bag/backpack/tote/handbag/suitcase/jacket/coat/hoodie/parka/cardigan/sweater/blazer/umbrella/helmet/scarf、paper bag 等は除外）に限定。水筒・カップ・ノート PC・紙類は検査対象外。再起動 5 で反映。
- **2026-10-19 18:5x 不採用でキャプチャ全体を落とさない**（L003 18:31–18:48、無人回 11 件中 8 件 failed。検査は正しく、missing_belongings=青いリュック消失が主、framing_drift 1 件）。従来は `server.ts` のシーンループで `maxAttempts: isTurboEngine(engine)||…?1:2` → 後ろ姿/無人シーン（turbo）は 1 回で、1 回の不採用が `Person identity check failed after 1 attempts` で capture ごと失敗し、後続シーン未生成・オペレーターループが再失敗して停滞していた。
- 新フロー: 無人キャプチャ・人物なしシーン・後ろ姿シーンは 2 回（有人シーンは従来通り qwen2511=2 / turbo=1、テストの automaticImageRetries=false は 1）。2 回目の補正文は `peopleIntegrity.ts` の `targetedCorrection(verdict)` が defect/reason から作る: missing_belongings →「The blue backpack must remain fully visible exactly where it is in the input; the person stands beside it, not in front of it.」（無人なら do not move, cover or remove it）、framing_drift →「Keep the exact framing, scale and rotation of the input; do not zoom, shift or tilt the camera.」、extra_hand →「Each person has exactly two hands and two arms; …」、人数/同一性 → 従来の identity 文（期待 0 人なら No person may appear）。
- 最後まで不採用（ok:false）なら `generateUniquePeople({onExhausted:'skip'})` が skip 結果を返し、そのシーンは G-24 と同じ扱い: capture.saved/browserBatch/QA なし、以降の datagram の expectedImageCount を 1 減らす、prompts.json scenes[] に skipped+skipReason `rejected:<defect>`、capture-events skippedScenes に追加、表示は前回画像のまま。ログ `[integrity] scene gen_x skipped after 2 rejections: <defect>`。キャプチャは completed で終わる。
- 例外（検査不能 ok:null・生成エラー）は従来通り capture failed。不採用画像は従来通り rejected/<captureId>/ に保存。テスト: `peopleIntegrity.test.ts` に 3 件追加（補正文・2 回不採用で skip・有人経路不変）。tsc クリーン、TS スイート 940/942（既知 2 件）。サーバー未再起動 → 次の再起動で反映。
- **決定（2026-10-19 夕、ユーザー「じゃあそれでいく」）: Control 本体・Mapping・History は公開 URL（Funnel）に出さない。**操作は tailnet 内からのみ（自分の端末は Tailscale アプリで同アカウント、他の人には管理画面 Machines → emergent-2 → Share で機器共有）。公開ゲート（3443、Funnel 有効中）は閲覧ページと /capture/ のみ。操作用ロールの実装は行わない。
- **2026-10-19 Input 切替のキュー化**: chain 中は前の capture 完了から約1秒で次が始まるため input.select がほぼ常に 409（Wait until generation finishes…）になり、Control からライブカメラに切り替えられなかった。
- 修正: `nativeOperator.ts` で busy 中の input.select は 409 でなく受理してキュー（pendingInput {setId, requestId, requestedAt}、新しい要求が古いものを置換）。メッセージ "Input change queued: <setId> (applied after the current generation)"。スケジューラ tick の冒頭（capture 完了直後・chain が次を投げる前）で適用し、ログ "[input] queued select applied: <setId> → <kind>"。失敗は state.errors に記録してキューを破棄。input-selection.json は select 成功時のみ保存。idle 時は従来どおり即時。
- state スナップショットに `pendingInput`（なければ null）を追加（operatorState.ts）。Control の INPUT は pendingInput がある間 Switch ボタンが "Queued…"、詳細欄に "Queued… <setId> · applied after the current generation"。scenario.play の busy 409 はそのまま（文言のみ "pause generation first" に変更）。
- テスト: nativeOperator.test.ts に 4 件（busy→キュー→完了後・次 capture 前に適用 / 置換 / 失敗記録 / idle 即時）。反映は次回サーバー再起動から。

### 2026-10-19 追記: 背面人物（立ち）の具体的な空き位置と missing_belongings 検査（サーバー未再起動）
- 症状: 無人＋直近人物の背面描画で「立ち」のとき、青いリュックと黒い上着が掛かった椅子の位置に人物が立ち、持ち物が消える／大半が隠れる（TSC-003 F004 …1792399936150 A、…1792400000251 C）。座りの描画（B など）は持ち物が残る。
- 修正1（behindViewPlacement.ts）: 立ち・歩き（座りでない）動作のときだけ、従来の汎用保護文の後に1文追加: 「Free spot for the standing person: standing to the LEFT/RIGHT of the chair, in front of the empty part of the desk, not overlapping the chair; the chair with <持ち物> stays fully visible to the right/left of the person」＋「空いている椅子（何も載っていない）があればそこに座ってよい、持ち物の載った椅子の上・前・代わりには立たない／座らない」。左右は guard.scene の位置語（"chair at the right" 等）→ 直近人物の headBox（0-1000）→ position 語の順で決め、空きの多い側（物が右なら左）。手がかりなし（F004 は scene に持ち物も位置も無く position=center）は "on its side farther from the centre of the image"。server.ts は scene と headBox を behindView に渡す。
- 修正2（combinedInspection.ts、呼び出し回数は1回のまま）: scene が単数形で挙げる持ち物（inspectionBelongings、最大4件、動作文や人物の holding/worn にある物は除外）があれば、schema に必須 objectsVisible {名前: boolean} と指示「出力画像でほぼ同じ場所に見えるか、人に隠れた／消えた = false」を追加。false が1つでも ok:false・defect missing_belongings（両検査経路）。observationFacts.belongings {checked, visible, missing} に記録。リストなし＝質問なし・判定なし、回答欠落は不明扱い（不合格にしない）。
- QA: localJudge の DEFECT_TYPES に missing_belongings。server.ts の却下行と qaService の参照キャスト再検査は inspectionDefectType で実際の defect（framing_drift / extra_hand / missing_belongings）を記録（以前は再検査が常に fabricated_person）。
- テスト: server/generation/behindViewFreeSpot.test.ts（5件）、belongingsInspection.test.ts（2件）、qaService.test.ts に1件。tsc クリーン、全 935 件中 933 合格（既知の2件のみ失敗）。反映にはサーバー再起動が必要。
- 追補（持ち物の出どころ）: guard.scene は持ち物を書かないことがある（F004 は scene にリュックも上着も無し）ため、毎撮影（無人含む）走る describe 呼び出し（peopleDescribe.ts）に必須 belongings [{name, on, position: left|center|right}]（最大6、人の有無に関係なく、鞄・上着・椅子/机/床の置き物）を追加し、guard.belongings として prompts.json に保存。parseSceneBelongings は欠落→[]。num_predict 512→768（切れ防止）。DESCRIBE_SCHEMA が変わるので参照人物観測のキャッシュキーも変わる（再観測されるだけ）。
- 利用: 空き位置の文は scene に名前・位置が無いとき guard.belongings の名前と position を使う（F004 で describe が blue backpack / black jacket on chair, left を返せば「standing to the RIGHT of the chair, in front of the empty part of the desk, …; the chair with the blue backpack and the black jacket stays fully visible to the left of the person」）。objectsVisible の対象は guard.belongings → scene の単数物の順で名詞重複を除き最大6。テスト追加（behindViewFreeSpot.test.ts 計9件）、tsc クリーン、939 件中 937 合格（既知2件）。

### 2026-10-19 追記: framing_drift（CPU 構図チェック）と背面人物の置き場所（サーバー側の変更あり・要再起動）
- 不具合1: TSC-003 F006 の C（Gen_c_2026-10-19_17-28-38）がズーム・ずれのまま公開された。pre-publish 検査（combinedInspection.ts）に scripts/frame-align.py（ORB + RANSAC estimateAffinePartial2D + Canny edge IoU、640px、CPU のみ）を hand-count と同じく1画像1サブプロセスで VLM と並列に追加（server/frameAlign.ts）。比較元は常に NOW（背面人物シーンでも inspectAndCaption の第7引数 frameSource=NOW）。
- 判定: inliers≥60 なら |scale−1|>6%・|dx|または|dy|>4%・|回転|>2° で defect framing_drift（ok:false、従来どおり再試行／integrity.jsonl・qa-local.jsonl に記録）。inliers<60 のときは edgeIou<0.35 のみで不合格。スクリプト・python が無い／エラーなら判定に影響しない（VLM のみ）。
- 実測: 17-28-38 C は dy −18.6%・回転 −1.0°・edgeIou 0.54 → 不合格。同じループの合格29枚は scale 0.992–1.001、|dx| ≤0.64%、|dy| ≤0.17%、|回転| ≤0.04°、edgeIou ≥0.77 → 全合格。当日全体90枚のサンプルでは別に8枚（00-02-08 A、07-17-01 A、10-20-06 A/B、14-09-13 A/B/C、16-07-25 A）が同様のずれで不合格になる（目視でずれを確認）。
- 記録: observationFacts.framing {status, scale, dx, dy, rotationDeg, inliers, inlierRatio, edgeIou, edgeIouAligned, drift?, ms}。scripts/inspect-images.ts --cpu-only は手の数と構図の両方を出す（frameVerdict）。QA の defect 種別に framing_drift を追加。
- 不具合2（G-14）: 背面人物（behindViewSentence）が椅子の上に描かれ、掛けてあったリュックと上着が消えた。配置文を追加: 既存の家具・物の「横」に立つ／座る、物の上・中・代わりには置かない、入力の物（鞄・上着・椅子や机の上の物）はすべてその場に見えたまま残す、元の位置が物で埋まっていれば最も近い空いた床（例: 椅子の横）に置いて物に触れない。物の名前は guard.scene から抽出（server/generation/behindViewPlacement.ts の sceneBelongings、無ければ一般語）。ネガティブにも person replacing an object / missing backpack などを追加。

### 2026-10-19 追記: 起動時の入力再同期（サーバー側の変更あり・要再起動）
- 再起動後にサーバーの表示（TSC-003 など）とラップトップのブリッジ（live-camera）が食い違い、約30分生成が止まった件の対策。
- 最後に成功した input.select を operator ディレクトリの input-selection.json に保存。起動時に、保存があればその setId をそのまま1回だけ input.select し、「[input] resync: <setId> → <kind>」をログに出す。保存がなければ何も送らない（camera を勝手に選ばない）。remote-device は再送しない。
- 再同期後、または60秒ごとの確認でブリッジの状態が保存値と食い違うと、state.errors に「Input bridge mismatch after resync」を記録（自動の再選択は起動時の1回のみ）。次回の再起動から有効。

### 2026-10-19 追記: シナリオCSV の FORMAT ERROR / WARNING（サーバー側の変更あり・要再起動）
- 読み込み時（Load CSV・Import・起動時の既定CSV）に全行をチェックし、最初の1件で止めずに全問題を {row（ヘッダー=1 の CSV 行番号、0=ファイル全体）, column?, message, severity} で返す。実装は scripts/operator-scenario/scenario_csv.py の collect()（parse()/load() は従来どおり最初のエラーで ValueError）。parse_plan.py は成功 exit 0 {ok:true,plan,formatWarnings}、エラー exit 2 {ok:false,formatErrors,formatWarnings}。
- エラー（読み込まない）: ヘッダー（重複・未知・必須欠落）、列数、CSV 構文、未知の action、target/value の形式と範囲（output_*・mode・interval_sec・distance・presence・tone・empty_person・person_refs(_once) の UUID・pause/resume・scene_mode など）、seconds の範囲、メタ行（scenario/instructions/loop）は 0 秒に各1回、end は1回まで、end より後の cue、画像列は image 行のみ、画像ファイルの存在・フォルダ内・.png・サイズ。警告（読み込む）: 使われていない任意列、同じ note の重複、seconds の逆順、end 行なし。
- Node: server/operatorScenario.ts の checkOperatorPlan() が ScenarioFormatError（HTTP 400、body に formatErrors/formatWarnings）を投げ、直前の正常なプランはそのまま残る。結果は scenario.formatErrors / formatWarnings / formatCheckedAt / formatFile として state に残り、エラーなしで読み込むまで消えない。既定CSVが壊れていても起動は止まらない（プラン無し＋FORMAT ERROR 表示）。
- コントロールパネル（index.html のシナリオ欄・control.mjs）: エラーは赤い「FORMAT ERROR · N」、警告のみは黄色い「WARNING · N」。その下に「row N [列]: 内容」を最大20件＋「…他 X 件」。CRCRLF の CSV も表計算ソフトと同じ行番号になるよう正規化。
- テスト: Python test_format_check.py（9）を追加し 26件 OK、nativeOperator.test.ts に1件追加。tsc クリーン、TS 全体は既知の2件以外の失敗なし（SSE heartbeat テストは並列時のみ1回失敗し、単体では通過）。既存の CSV 54件は全てエラーなしで通過。

### 2026-10-19 追記: 公開ゲート（Funnel 用 127.0.0.1:3443）＋外部デバイス・ライブカメラ（コードのみ。秘密未生成・未公開）
- 設計 docs/PUBLIC-OUTPUT-AND-REMOTE-CAMERA-DESIGN-2026-10-19.md の実装。server/publicGate/（index.ts 第2 Express・許可リスト・ループバック転送 Host=localhost:3000、auth.ts scrypt＋HMAC cookie 12h＋失敗5回/10分/IP・全体50回/10分、login.html、capture.html/.mjs）、server/remoteCamera.ts。server.ts は listen 直前の 1 行（動的 import、失敗しても起動に影響なし）。
- 秘密が無ければ完全に無効（ログ 1 行「public gate disabled (no secrets)」、リスナーなし）。PUBLIC_GATE_ENABLED=false でも無効。ポートは PUBLIC_GATE_PORT（既定 3443）。:3000 は絶対に Funnel しない。
- 秘密の生成: `npx tsx scripts/ensure-public-secrets.ts`（.env.local に PUBLIC_OUTPUT_PASSWORD / PUBLIC_COOKIE_SECRET / PUBLIC_CAPTURE_TOKEN を無い時だけ追記、出力は ok のみ。.env.local の変更で vite が自動再起動するので撮影の合間に）。パスワードの置き場所は `.env.local` のみ。表示は本人の端末で `scripts/show-public-password.ps1`。
- ユーザー手順: 再起動後 http://127.0.0.1:3443/login でパスワード確認 → 表示を確認できたら本人が `tailscale funnel --bg 3443`（停止 `tailscale funnel --bg off`、だめなら `tailscale funnel reset`）。
- 公開されるのは /display/<id>・/control/output/1-4・/control/screen/screen-N とその JS/CSS・snapshot API 3 種・直近 30 分に配信した snapshot が参照した画像だけ。GET/HEAD のみ、クエリ・%・..・\ は 400、それ以外は 404/405。
- **ブラウザの顔ぼかしは匿名化ではない**。ゲートは faceBlur がオンの出力が参照した画像だけ、サーバー側でぼかしたコピー（scripts/face-blur-render.py、cv2、楕円 rx=0.5w ry=0.56h、元画像は不変、キャッシュ）を返す。顔検出が unavailable/error のときは原画像を出さず 503。faceBlur オフの出力は原画像。
- リモートカメラ: スマホで `https://<funnel>/capture/?token=<PUBLIC_CAPTURE_TOKEN>`（cookie 発行後 /capture/ へ）→ 開始 → 1280x720 JPEG を 5/10/20 s ごと（既定 CAPTURE_INTERVAL_SEC=10）に送信、メモリに最新 1 枚だけ。Control の INPUT で「Remote device (phone)」を選んだときだけ NOW に使う（sourceScope camera:remote、captureId remote-<ms>-<sha8>）。30 s（REMOTE_STALE_SEC）超は撮影拒否「remote camera stale」（Control と /api/health の remoteCamera）。
- 注意（テストループとの関係）: remote-device はライブ扱いで会場履歴・記録フレーム・人物ルールの presence に入る。選んだまま放置しない。選択は保存されず、サーバー再起動で laptop 側の選択に戻る。動作確認は /api/generate に test:true を付けた別経路で。
- テスト: server/publicGate/publicGate.test.ts（6）、server/remoteCamera.test.ts（2）。tsc クリーン、全 992 件中 既知の 2 件以外の失敗なし。サーバーは再起動していない・何も公開していない。

### 2026-10-19 追記: Fixed scenes / Routing slots に Label・Text の切替（サーバー側のみ・サーバー未再起動）
- 保存: POST /api/browser-outputs に任意の `channelCaptions:{<key>:{labels,subtitles}}`（key は current-now/a/b/c・control-output-1..4 の8つ、値は boolean、部分指定は既存値にマージ）。省略・旧保存データは全部 true。未知キー/非 boolean は 400 "Invalid channel captions"。GET と revision に含む（再起動後の初回は revision が変わるので画面は Reload）。
- 表示: /display/current-* の view.labels/subtitles = TD routing の view（既定 true）AND channelCaptions。/control/output/N = コントロールパネルの labels/subtitles 設定 AND channelCaptions。screen-N の扱いは不変。
- シナリオCSV: `output_labels` / `output_subtitles` の target に current-now・current-a/b/c・control-output-1..4 も可（例 `12,output_labels,current-a,false` / `20,output_subtitles,control-output-2,true`）。他の output_* でこれらを指定するとエラー。Preview は一時上書きのみ（保存しない）、Live は保存し Stop で元に戻す（output_* と同じ。自然終了では戻さない点も同じ）。
- UI（Downloads の pr-ui-cap-mapping.*）はユーザーが配置。配置後にサーバー再起動が必要。テスト: browserOutputs / operatorScenarioOutputs / nativeOperator に追加、Python test_output_mapping に3件。

### 2026-10-19 追記: G-24/G-25 無人シーンの人物確率・物の変化ゲート・skip（サーバー未再起動）
- 新規 server/generation/emptyRoomDecision.ts。場面ごとの再現可能な乱数 r = sha256(`${captureId}:${sceneKey}`) 先頭32bit/2^32。無人フレームで直近10分の人物（live 履歴 / テストスコープ testRecentPerson）がいれば r < emptyRoomPersonChance の場面だけ後ろ姿で描く。その場面の sceneExtras（Continuous / One shot / シナリオ prompt）が人物に触れていれば確率に関係なく描く。直近人物なし→描かない（G-01）。
- 物の変化（emptyRoomObjectChange / プランナーの物の変化）は、最後の有人フレームが EMPTY_ROOM_ACTIVITY_MIN（既定3分）以内 かつ r2 = sha256(`…:object`) < EMPTY_ROOM_OBJECT_CHANCE（既定0.3）のときだけ。どちらも env のみ（スライダーなし）。画像要素・scene_mode・人物参照のある場面は skip しない。
- 人物も物の変化もない場面は skip（reason: no_recent_activity / no_movable_object / chance）。vlmClient finishWith が scenario.skipped を付け、server.ts のループが continue。capture.saved はその場面だけ送らず、expectedImageCount = 実生成数、payload に skippedScenes。prompts.json scenes[] に {skipped:true, skipReason}、emptyRoom（chance/roll/personDrawn/reason）、README に skip 行。capture-events に skippedScenes / emptyRoom。QA は生成分のみ。latest-prediction は skip 場面の前回文を保持。
- ブラウザ出力（browserOutputCurrent / tdBrowserFollow / browserFade）: skip 場面を除いた batch を complete と判定。skip 画面は前回の画像・字幕・前回 fadeBatch のまま（黒フェードなし、失敗表示なし）、NOW と他の画面は通常更新。screen.mjs / output.mjs は変更不要。
- 設定 emptyRoomPersonChance（0..1、既定0.3）: operatorState settings.apply（revision 更新、旧保存 state は 0.3 で補完）、sceneParams で clamp、/api/generate body で上書き可、operatorGeneration が body に載せる。Control の WORLD PARAMETER にスライダー「EMPTY-ROOM PERSON」。シナリオ CSV action empty_person（例 `0,empty_person,,0.5`。preview skip / Stop・end で復帰 / 競合ルールは presence と同じ）。examples/SCN-SETTINGS-001.csv に1行追加。
- ノートPC側（未変更・要対応）: td_scene_text.on_capture_payload は新 captureId で clear() するため skip 場面の字幕が消える → payload.skippedScenes の場面は clear しない。td_capture_listener の fade_state 'refade' は全画面を黒に落とす → skip 場面の窓を残すなら窓ごとのフェードが必要。全場面 skip の回は capture.saved が無く TD の NOW も更新されない。
- テスト: emptyRoomDecision.test.ts（10）、browserOutputCurrent / operatorState / operatorScenarioSettings / generationArchive / sceneParams に追加、Python test_settings_actions に empty_person。tsc クリーン、TS 883 件中 既知の 2 件以外失敗なし。サーバーは再起動していない。

### 2026-10-19 追記: テスト再生で G-01/G-02（最近の人物を後ろ姿で）が一度も効いていなかった件（サーバー未再起動）
- 発見: 直近の無人 40 バッチすべてで 1.1〜4.9 分前に在室フレームがあったのに prompts.vlm.guard.recentPersonAllowed=false。展示はテストループ（captureId test-…、historyScope test:TSC-001:<run>:L<loop>）で回っており、server.ts は isTest のとき useHistory=false → historyAll=[] → latestPerson が常に null だった。logs/scene-history.jsonl の最終行は 2026-10-18T02:22:39（td-…-1、無人）で、テスト撮影は書き込まない（仕様どおり）。
- 修正: 新規 server/history/testRecentPerson.ts。テストスコープ（kind test）のときだけ、同じループの ScopedTestHistory（キャッシュ済み原観察、detectorPerson=true かつ people あり、再生時刻 replayedAt が RECENT_PERSON_WINDOW_MIN=10 分以内、現フレーム除外）から recentPerson を作る。参照画像は同ループで受け取った在室フレームの元画像（TestPersonFrames、スコープ12×4枚のメモリのみ）。展示 jsonl は読み書きしない。ループをまたぐ持ち越しはなし（スコープ分離のまま）。
- 以降は既存経路のまま: allowPerson → vlmClient finishWith（allowPerson=true なら emptyRoomObjectChange は出ない＝最近の人物が優先、無ければ物の変化）→ drawFromBehind/behindView（服・髪・位置）→ referenceCrop → generateTurboProduction の faceImage/faceCrop。
- 13:23:07 JST の「behind」一致は rulebook の例文（"the desk behind him"）で、behindView は false だった（誤検出）。テスト server/history/testRecentPerson.test.ts（4件）。tsc クリーン、既知の 2 件以外の失敗なし。

### 2026-10-19 追記: 3本目の手（extra_hand）対策（サーバー未再起動・ルールブック変更なし）
- 発見: v19 後の B 画像 Gen_b_2026-10-19_14-06-42（F010）/ 14-05-26（F009）に3本目の手。プロンプトが「片手を軽く上げる」と同時に「black tablet in both hands, with the original hand grip」「in the same hand」を指示し、両手が塞がったまま手を要求していた。
- 修正1（文面）: server/generation/handConflict.ts を新設。動作が手を要する（raise/wave/place/point/touch…）かつ持ち物が両手・腕組み・抱え持ちのとき、fidelity（actionWithBelongings / identityConstraints）、compactPeople、sceneExtras の Hand use、sceneReferenceCast、orchestrator の holdingsRule から「both hands / original hand grip / same hand」を外し「The black tablet is now held against the body with one arm only; the other hand rises lightly. Exactly two hands; no extra hand or arm.」に置換。片手持ちで反対の手が使える場合は従来文のまま。
- 修正2（公開前検査）: combinedInspection の既存1回の呼び出しに人物ごとの hands（整数）をプロンプトと JSON schema に追加。3以上で ok:false・reason "extra_hand: …"・defect "extra_hand"（人数不一致と同じ不採用経路、qa-local.jsonl の defect type も extra_hand）。2以下・欠落は通過。モデル呼び出しは増やしていない。
- 回帰素材: scripts/qa-known-cases.cmd に 2026-10-19_03-41-22:B / 14-04-33:B / 14-05-47:B を追加（extra_hand）。テスト server/generation/handConflict.test.ts（5件）。

### 2026-10-19 追記: extra_hand 検査の見逃し修正（v2）と「腕をほどく」動作文（サーバー未再起動）
- 原因: 検査は1回の呼び出しで出力画像のみ（人数1のとき。2人以上は原画+出力）を 1280x720 のまま送る（コード側の縮小なし、Ollama qwen3-vl:4b-instruct 側の内部リサイズのみ）。hands は schema の最後で、長い手の指示文の後に置かれ、タブレットを抱える2本の手を1本に数えていた。
- 修正（呼び出し回数は1回のまま）: combinedInspection の schema 先頭に raisedHands / objectHands / otherHands → handPositions（手ごとの位置の文字列）→ hands の順で必須化し、HAND COUNT 指示を手の指示文の前へ。判定は observedHandCount: handPositions が1件以上あればその件数（3件以上で extra_hand、hands=2 でも却下）、空なら hands。observationFacts に handPositions/領域数を保存。
- 回帰（qwen3-vl、12回）: 14-05-47_B_new 却下(3) / Gen_b_14-06-42 却下(3) / B_new_s1 通過(2) / Gen_b_14-05-26 は通過(2)＝まだ見逃し（胸の手をバッグ持ちと解釈）。B_old / B_old_s1 は最終文面で未計測（予算切れ）。4b モデルは文面の小変更で件数が大きく揺れる。
- 生成側: handConflict.armsChangeAction。両腕で抱える/腕組み＋raise/wave のとき動作文そのものを「uncrosses the arms, keeps the <物> against the body with one arm, and raises the other hand …; exactly two hands.」に（両手持ちは「takes one hand off the <物>, …」）。orchestrator.composeEditInstruction と sceneReferenceCast で適用し、Main change 行も同じ文。テスト handConflict.test.ts（8件）。

### 2026-10-19 追記: 後ろ向き固定文の誤適用を修正（サーバー未再起動・ルールブック v19 は未有効化）
- 発見: 2026-10-19_12-18-47 シーン C の A/B（ブロック①〜③を順に足す）で、①所持品・②人数/手までは動作（机に手を置く）が残り、③で消えた。原因は compactPeople の「Their back remains toward the camera, with their face hidden.」。元フレームは顔が見える（横/正面）のに describe が facing を away と誤報し、この文が人物を直立・後ろ向きに固定していた。
- 修正1: この固定文は behindView（G-02 最近の人物を後ろ姿で描く経路）のときだけ出す。composeEditInstruction が args.behindView を compactPeopleInstruction の第4引数へ渡す。通常の在室シーンで away の場合は弱い文「Do not reveal more of the face than is visible in the input.」に置換（G-15 は noNewFaceRule のまま）。
- 修正2: peopleDescribe の facing を toward | side | away | unknown に明示（DESCRIBE_PROMPT と JSON schema の enum、parsePeople で旧自由文を正規化）。unknown のときは compactPeople で facing 文を一切出さない（服装・位置は残す）。ブロック①②は変更なし。
- 顔検出（faceRegionStatus）は表示用ブラウザ経路にしかなく生成時に使えないため、判定は behindView のみ。新しいモデル/AI 呼び出しは追加していない。
- テスト追加: compactPeople（away+behindView→固定文 / away のみ→弱い文 / unknown→facing 文なし）、parsePeople の facing 正規化。tsc クリーン、既知の 2 件以外の失敗なし。サーバーは再起動していない。ルールブック v19 も未有効化。

### 2026-10-19 追記: 「動作が出ない件」指示文の修正（サーバー未再起動・ルールブック v19 は未有効化）

- 原因: 動作指示が指示文の段階で消えていた。①辞書の部分一致で「椅子に座ったまま机を見る」が毎回 "sits down" になり「机を見る」が消えた ②手がふさがっていると机に手を置く動作文そのものが削除された ③両手がふさがっている時の挙手が「握りを保て」と矛盾 ④「横顔は横顔のまま」の固定で視線・頭の動きも禁止 ⑤「物を足さない」ほぼ同文 5 文が動作文を埋もれさせた。
- コード（server/generation/sceneExtras.ts, vlmClient.ts, orchestrator.ts, compactPeople.ts, fidelity.ts, sceneReferenceCast.ts, 新規 mainChange.ts）:
  - 辞書は語句全体の完全一致のみ。まま/ながら/ずに等の修飾や辞書外は意味を保つ翻訳（translateActionPhrase、姿勢ヒント付き、num_predict 64）をそのまま使用。"stays seated ... and looks ..." を「変化なし」と誤って捨てる判定も修正。立っている人の「座ったまま」は "sits on the chair and looks at the desk" に合わせる。
  - 手がふさがっていても動作文は残し、"Hand use: ...; exactly two hands. Never add an extra hand or arm." で手の使い方を指定（物を持ったまま置く/先に机に置く、挙手は物ごと上がる）。
  - 人物ありの指示文の末尾に 1 回だけ "Main change that must be clearly visible: <動作文>"。
  - 日本語の表示文の作り方は変更なし（辞書ヒット時だけ使っていた短縮形は、完全一致以外では元の指示文のまま）。
- ルールブック v19（scripts/rulebook-add-motion-v19.ts で作成、active は v18 のまま）: 頭・視線は動作に必要な範囲で動いてよいが見えていない顔は出さない（G-15 維持、横顔固定を削除）、持ち物は同じ手で一緒に動く（G-14 維持）、物の文を 1 文に統合。有効化: `node_modules\.bin\tsx.cmd scripts\rulebook-add-motion-v19.ts --activate-existing`（ホットリロードされるので再起動と同時に行う）。
- 検査（combinedInspection / sceneReferenceCast の判定）は変更なし。差分: docs/motion-prompt-diff-2026-10-19.md。A/B 用: scripts/motion-ab.ts（未実行）。
- サーバーは再起動していない。コード変更は次回再起動から有効。

### 2026-10-19 追記: オペレーターシナリオCSVでコントロールパネル設定を変更（サーバー未再起動）

- 新しいCSVアクション（列は seconds,action,target,value のまま。画像列は空必須）:
  - `mode` value=manual|timer|chain（target空） / `interval_sec` 5..3600 秒（target空）
  - `distance` target=A|B|C, value=-3600..3600 秒 / `presence`・`tone` 0..1（target空）
  - `person_refs` / `person_refs_once` target=A|B|C, value=UUIDを `|` で連結（空=クリア, 最大15件, 重複不可）。continuous / oneShot の PersonReferenceIds をそのシーンだけ置き換える
  - `pause` / `resume`（target・value空）= generation.pause / generation.resume と同じ処理（submissionHold）。シナリオ時計は止めない
  - cast / allowedInventory は追加していない（生成ごとに導出されるため）
- 不正値はCSV読込時に拒否（scenario_csv.py / scenario_engine.py、Node側でも validateScenarioSettingsChange で再確認）。
- 実行時は必ず既存の settings.apply / generation.pause / generation.resume を通る（受領票・検証・settingsRevision そのまま）。シナリオ発のときだけ「シナリオ所有中は scenes/mode を拒否」のガードを通す（`state.scenarioAction`、HTTPからは偽装不可）。person_refs は settings.apply の件数・合計上限に加え、実行時に参照メタデータの存在も確認。
- プレビュー再生では何も変更しない。`scenario.settingsCues` に `status:'skipped', skipped:'preview', change:'scenes.a.distanceSec=10'` 等で記録、`skippedSettings` / `lastSettingsSkipped` も出る。コントロール画面のプレビュー表示に「Settings not applied (preview): …」を追記。
- ライブ再生で行が失敗（検証エラー等）しても、その行だけ `status:'failed', error` と `lastSettingsError`（`row-0005 (presence=0.5): 理由`）に記録してシナリオは続行。
- 復元ルール: 終了時と Stop 時に、このシナリオが変えた項目だけをシナリオ開始時の値へ戻す（settings.apply 経由）。開始後に同じ項目が手動で変わっていたら（シナリオが書いた値と現在値の比較）上書きせず `lastSettingsError`（`Restore on stop: … not restored`）に記録、Stop は 409 を返す（lastOutputError と同じ扱い）。hold（pause/resume）も同じルールで開始時の状態へ戻す。
- 例: `scripts/operator-scenario/examples/SCN-SETTINGS-001.csv`（0s distance A 10 / 4s presence 0.5 / 8s tone 0.3 / 12s pause / 16s resume / 20s end、generate行なし）。
- 主な変更: server/operatorScenarioSettings.ts（新規）, operatorScenario.ts, operatorState.ts, nativeOperator.ts, server.ts（checkPersonReferences 配線）, tdControl/control.mjs, scenario_csv.py, scenario_engine.py。テスト: test_settings_actions.py, operatorScenarioSettings.test.ts ほか。
- **本番サーバーは再起動していない。** 反映には再起動が必要（ユーザー判断）。
- **2026-10-17 13時: 遮蔽時の前後関係(ルールブック v10→v11、denoise 0.6)**: v10 の「奥の物を手前に出さない」文だけでは画像が直らず(Lightning cfg 1.0 では負のプロンプトは無効)。A/B(`speculative-memory_data/experiments/obstruct-ab`): (a) v10 再現 NG、(c) 先頭文「The mesh chair backrest is the frontmost layer… everything seen through the mesh stays dim, blurred…」OK、(d) denoise 0.6 OK、(b) 非 Lightning は時間内に未検証。v11 = (c) を `imagePrompt.obstructedLeadRule`(`rulebook.ts` の `obstructedLead()`、`{by}` に obstructedBy)として obstructed 撮影の画像プロンプト先頭に置く(13:13:32 反映)。それでも 13:13:37 の B に文字つき小画面が手前に浮いたため、obstructed 撮影だけ `COMFYUI_OBSTRUCTED_DENOISE`(既定 0.6、1 で無効、prompts.json の各シーン `denoise`)を併用(13:20 ごろ反映)。以後の遮蔽撮影 3 件の B は浮く物・新文字なし。A の 1 件に虹色の光条(未対応)。通常撮影は denoise 1.0 のまま。
- **2026-10-17 昼: ComfyUI ハング 7 時間と復旧、自動復旧、G-16、alert 表示**: 05:31 から ComfyUI のジョブ 1 件がハング(GPU 29%、VRAM 21GB)。サーバーは 300 秒でタイムアウトするが ComfyUI のキューに残るため 71 件滞留。/interrupt と /queue clear は効かず、python 停止→同じ引数で再起動(cwd `C:/Users/nmrei/AppData/Local/Comfy-Desktop/ComfyUI-Installs/ComfyUI`、`scripts/restart-comfyui.ps1`)で 12:38 復旧。サーバー側: タイムアウト時にそのジョブを削除、連続 2 回(COMFYUI_FAIL_RESTART_AFTER)で自動再起動、/api/health に comfyQueue/lastTimeoutAt/autoRestarts/comfyAlert、1 回目から /logs 赤バナーと UDP `alert`。ルールブック v9: G-16(画面に新しい文字・数字・時計・UI を描かない、負のプロンプトに clock/digits/text on screen)と G-07 補足(obstructed 時は遮蔽物を含む構図を維持、裏の部屋を描かない)。**TD 側**(ノート、`td_scene_text.py` / `td_capture_listener.py`、リポジトリ反映済み): どの datagram でも `alert`(文字列または {message|text|title, level, active, cleared})があれば画像の行の上(ui_root 280,376,996x20)に赤帯「⚠ <message>」、active:false/cleared/空、または alert の無い generation.completed で消す。cost_display は y91/h16・12pt に変更(オーバーレイのボタンを隠さない)。次の課題: 遮蔽時に背もたれの奥の物(モニター)が手前にくっきり描かれる(-541 B)。
- **非表示コンソール（2026-10-17）**: `scripts/safe-restart.ps1` と `scripts/restart-comfyui.ps1`（comfyWatchdog の自動再起動を含む）は Win32_ProcessStartup の ShowWindow=0 で起動するため、サーバーと ComfyUI は窓の無いコンソールで動く。止めるときは `scripts/stop-server.ps1` か taskkill（窓を閉じる操作は不要）。既に開いている古い窓は次の再起動で置き換わる。
- **ComfyUI ハングの自動復旧（2026-10-17、未コミット）**: 10-17 05:31 に ComfyUI のジョブ 1 件がカーネル内でハングし、300 秒タイムアウトの失敗が 71 件、7 時間生成が止まった（/interrupt も /queue clear も効かず、python の再起動で復旧）。対策: `comfyClient.ts` はタイムアウト時にそのプロンプトを ComfyUI のキューから消す（cancelPrompt）。`server/generation/comfyWatchdog.ts` が連続タイムアウトを数え、`COMFYUI_FAIL_RESTART_AFTER`（既定 2）回で `scripts/restart-comfyui.ps1`（:8000 の python と親 python を止め、Comfy Desktop の .venv で detached 起動、75 秒以内に /queue 応答）を実行。再起動中は `/api/generate` が `whenReady()` で待つ（動いている撮影は止めない：タイムアウトした撮影自身は既に失敗中）。成功 1 回でカウントはリセット。`COMFYUI_AUTO_RESTART=false` で再起動だけ無効化。1 回目の連続失敗から警告: /logs の赤バナー、`/api/health` の `comfyAlert`、UDP `comfy.alert`、capture.saved の `alert`、events・display-log.jsonl の `comfyAlert`/`alert`。履歴要約には書かない。`GET /api/health` に `comfyQueue {running,pending}`・`lastTimeoutAt`・`autoRestarts`・`consecutiveTimeouts` を追加。スクリプトは `-DryRun` で起動コマンドだけ表示（実機での再起動は未検証。ハング時にしか試せない）。
- **カメラ遮蔽の表示（2026-10-16 23時、ノート側 TD 実装済み・サーバー側実装中）**: 20:00 以降カメラが椅子の背もたれで塞がれ、無人判定が「見えていないだけ」の可能性があった。方針（決定済み）: 生成は止めず、describe の判定 `obstructed`（true/false、`obstructedBy`）を guard record・capture-events・capture.saved に載せ、/logs に「遮蔽?」バッジ、履歴要約の結びに「(カメラが遮られている可能性)」。**TD 側**（`td_scene_text.py`、ノート）: capture.saved に `obstructed:true` があれば NOW パネル見出し行の右に赤字「カメラが遮られている可能性」（`set_obstructed(flag)`、textCOMP 'obs'）。false またはフィールド無しは非表示、新しい captureId でリセット。ついでに extrasStatus の「無人のため未使用」を継続欄の右下へ移動（入力文との重なり解消）。リポジトリに反映済み（23:10）。直近 2 人の扱いは「直前の 1 人だけ後ろ姿」のまま（決定）。
- **カメラ遮蔽（サーバー側、2026-10-16 23時）**: `server/generation/peopleDescribe.ts` の `DESCRIBE_PROMPT` に `obstructed`（bool）/`obstructedBy`（英語4語まで）を追加、`parseObstruction()` で読み、`describePeople` の戻り値に載せる（判定が取れなければフィールド無し=不明）。`server.ts` が `evt.obstructed` → `logs/capture-events.jsonl`、guard record（`GuardRecord.obstructed/obstructedBy`、`vlmTrace.guard` へ server.ts から書き込み。orchestrator は未変更）、UDP `capture.saved.obstructed/obstructedBy` に反映。`server/events/obstruction.ts`: `obstructedSince(events)`（新しい側から連続して `obstructed:true` の先頭の startedAt。テスト撮影と判定なしは飛ばし、最初の false で終了）と `withObstructionNote()`（要約の結びに「(カメラが遮られている可能性)」を1回だけ付加）。`/api/history-summary` は `obstructedSince` を返し、`summary` と capture.saved の `historySummary` に結びを付ける（`historySummary.ts` は未変更）。/logs の撮影行に「遮蔽?」バッジ。生成は止めない。

**2026-10-16 追記**
- **継続 QA とルールブックを実装（10-16 20:26 再起動、未コミット。詳細は docs/RULEBOOK.md）**: 生成後の 3 枚を撮影の合間にローカル Qwen で検査（`server/qa/localJudge.ts`、撮影中は走らない・新しい撮影で中断、1 枚 約 8 秒＝3 回の短い呼び出し）→ `logs/qa-local.jsonl`、`_prompts.json` の `qaLocal`、capture-events の `qa`。API `GET /api/qa`・`/api/qa/summary?by=rulebookVersion`・`/api/qa/proposals`・`/api/rulebook`、`/logs` 上段に版ごとの不良率と変更履歴。4B は「欠陥はあるか」と聞くと常に OK と答えるので、差分の列挙→サーバー側で分類（見落としはある。比較用の指標）。
- 固定制約・テンプレート・負のプロンプト・ガード設定・計画への追加指示を `rulebook/rulebook.v<N>.json`（v1=従来の文言そのまま、`server/generation/ruleTexts.ts`）に集約。有効な版は `rulebook/active.json`（**書き換えるだけで次の撮影から反映、再起動不要**＝手で戻す最短手順）。各撮影の prompts.json・capture-events・capture.saved に `rulebookVersion`。G-xx（USER_GUIDELINES.md）の文言は自動改善の対象外。
- 自動改善 `server/qa/improver.ts`: 現在の版で 30 撮影（`QA_IMPROVE_EVERY`）ごとに、上位 1〜2 種別の不良に対し「追加だけ」の小さな変更（負のプロンプトの語・制約 1 文・ガード語彙・計画 1 文、最大 2 項目）を新しい版として自動適用。次の 30 撮影で不良率（または対象種別の率）が +5 ポイント（`QA_ROLLBACK_DELTA`）以上悪化なら自動で戻して却下版に記録。**ユーザーに聞く（自動適用しない）**: 表現に関わる語（変化の大きさ・人物の有無・トーン・Presence/距離）、fabricated_person / mismatch、同じ種別が 3 版改善しない、3 項目以上、候補切れ → `logs/qa-proposals/<時刻>.md`（`[improver] needs the user`、`/api/qa/proposals`）。変更履歴は `rulebook/CHANGELOG.md`・`logs/rulebook-changes.jsonl`・/logs。
- 道具: `scripts/qa-judge.ts`（保存済み画像を検査）、`scripts/qa-backfill.ts`（過去画像で基準の不良率を作る）、`scripts/qa-improve.ts --dry-run|--apply|--rollback|--apply-proposal|--status`。下の「継続 QA とルールブック（… サーバー側は未着手）」の行は本項で置き換え済み。
- **スマホ版（未コミット、Tailscale 内のスタッフ端末用）**: ページ `http://100.66.171.99:3000/m`（縦・日本語・CDN なし、実体 `server/mobile/index.html`）。「会場」タブ=最新の会場撮影を C→NOW→A/B の順（符号付き距離で並べ替え）で縦表示、タップで全画面、左右スワイプ/ボタンで前後の撮影。「自分」タブ=端末のカメラで撮影（長辺 1280 に縮小）→距離/presence/tone/追加指示/backend（既定 local、Gemini は有料表示）を付けて生成。
- API: `GET /api/mobile/captures?limit&source=venue|mobile|all&captureId=`（アーカイブの prompts.json から）、`GET /api/archive-image/:生成ID/:ファイル名`（アーカイブ画像のみ、厳密な名前だけ許可）、`POST /api/mobile/generate`（→ {jobId}）、`GET /api/mobile/job/:id`（順番・待ち時間・段階）、`POST /api/mobile/job/:id/cancel`、`GET /api/mobile/status`。実装は `server/mobile/`（queue.ts / archiveList.ts / access.ts / routes.ts、テスト mobile.test.ts）。
- キュー: スマホ撮影は source='mobile' で順番待ち（1 件ずつ、1 件 ≈ 110〜160 秒）。**会場がアイドルのときだけ開始**し、実行中のスマホ撮影は会場撮影に取り消されない（`/api/generate` の本体を `handleGenerate(req,res,lane)` に切り出し、スマホ用は別の CaptureManager。会場は待たされないので重なった間は ComfyUI が直列に処理して遅くなる）。**TD には UDP を送らず**、latest.json / latest_scenes.json / 会場の履歴・サマリー・QA は更新しない。`logs/capture-events.jsonl` と /logs には source=mobile で残る。
- **保持期間**: スマホ撮影のアーカイブ（と captures/ の写し）は **ユーザーが消さなくても既定 24 時間で自動削除**（`MOBILE_RETENTION_HOURS`、0 で無期限。起動時と 1 時間ごと、source=mobile のフォルダだけ）。
- アクセス制限: `/m`・`/api/mobile/*`・`/api/archive-image/*` は接続元 IP（X-Forwarded は見ない）が 100.64.0.0/10・127.0.0.1・192.168.0.0/16 のときだけ。`MOBILE_ALLOWED_CIDRS`（カンマ区切り CIDR）で変更。
- **再起動事故（15:08:55〜15:19:22、約 10 分停止）**: 修正セッションの再起動で起動プロセスが無言で落ち、気づくまで止まっていた。その間のタイマー撮影は失敗/記録のみ。**再起動の必須手順**: (1) logs/server.log の末尾が `[capture] completed/failed/cancelled` を確認、(2) 起動コマンド（`Invoke-CimMethod Win32_Process Create` で `cmd.exe /c "cd /d <repo> && node_modules\.bin\tsx.cmd server.ts >> logs\server.log 2>&1"`）を用意してからポート 3000 の PID を停止、(3) 起動後 30 秒以内に netstat の LISTEN と `curl http://127.0.0.1:3000/api/health` を確認、無ければ即再試行して `logs/server.err.log` を読む、(4) 停止・復帰時刻と停止秒数を報告。`.env.local` の編集は vite が自動再起動するので撮影の合間に。
- -89 対応の修正（15:19:22 反映）: 直近人物経路で人物を 1 人に固定（`exactly one person`、負に two people / second person / duplicate person、複数人の語は差し替え）、髪の長さの明示と負のプロンプト（直前が long なら short hair / bob haircut、short なら long hair）、表示文の主語補完を人物主語の文のみに限定し、環境文のみの計画には人物の控えめな動作文を先頭に付加。実動作は次の「無人＋直近人物」撮影で未確認。
- 既知の不良例に追加: -89（15:02、無人・直近人物＝-88 の黒シャツ・明るい茶色ロングヘア・左手前）。A は G-02/G-12/G-13 すべて OK（後ろ姿・茶ロング・黒服・左寄り・控えめ）。NG: C に 2 人（右に黒シャツ・ボブ・横顔が見える＝複製か未知の人物、顔も見える）、B と C 左の髪がロング→ボブ（G-13）、表示文の主語補完が環境文にかかって「人物は容器がわずかに前へ押され…」と壊れ、しかも文は環境変化のみで画像には人物（食い違い）。対策（実装中）: 直近人物経路では人物を 1 人に固定（exactly one person、負に two people/second person/duplicate person、複数人の語は差し替え。複数人対応は見送り）、髪の長さを明示＋負に short hair/bob haircut（直前が long のとき）、表示文の主語補完は人物主語の文のみ・環境文のみの計画には人物の控えめな動作文を先頭に付加。直近人物経路の前回修正（14:50:15 再起動: 無人時は計画から extras 注記を除去、大腕ガードの除外を適用シーンのみに、記述の position を左/中央/右+手前/奥・hair を色/長さ/型に具体化、後ろ姿・位置・縮尺・髪の文をプロンプト先頭へ、表示文の主語補完）は -89 の A で効果確認。
- 既知の不良例に追加: 2026-10-16 14:43 の -81（無人・直近人物あり）A/B/C: 髪が全体ピンクのウェーブに（G-13、元は黒髪ストレート毛先ピンク）、人物が画面中央手前に大きく（G-12、元は右寄りの椅子付近）、C は extras「はしゃいでる」が適用されて万歳・B は「両腕を上に伸ばし」（G-03 補足 / G-11 違反）、B の表示文に主語なし。原因: 直近人物の経路（unoccupied + recentPersonAllowed）で extras の不適用・大腕ガード・位置からの参照切り出し（中央の汎用矩形 324,144,632x504 になっていた）・髪の文が効いていない実装漏れ。修正中。格子ノイズ解消（sharpen=0）と後ろ姿・服装の維持は -81 で確認済み。
- 顔・肌の格子状ノイズ（ユーザー報告「A future の顔がばぐってる。肌にぐりっじみたいなのがでてる」、14-21-09 A）の原因確定と対処: 原因は解像度・steps・VAE ではなく、ワークフロー末尾の **ImageSharpen（alpha 0.2、`comfyClient.ts` ノード "75"、`DEFAULTS.sharpenAlpha`）** が VAE 出力の 2px 周期の微弱な残差を増幅してスクリーンドア状にしていた（同 seed・同入力で sharpen なしは滑らか。V0 はアーカイブと画素一致で再現。8 steps / タイル decode / 解像度変更では消えない）。直近 12 撮影のほぼ全画像に網点があり、顔が大きい画像で肌に目立つ（振り向きより顔の画素数に依存）。対処: `.env.local` に `COMFYUI_SHARPEN_ALPHA=0`（`.env.example` にも記載）、14:42:59（-80 完了直後）に反映（vite が .env.local の変更で自動再起動する＝**.env.local の編集は撮影の合間に行うこと**）。時間増ゼロ。シャープさが欲しければ 0.05 まで。QA 用の機械検出の目安: 肌タイル（32px、Hann 窓 FFT）の高周波帯（≥0.375 cycles/px）/中域（0.1〜0.25）の log10 中央値が −0.1 超で格子疑い（顔矩形限定なら −0.6 超）。肌タイル 3 個未満は判定しない。実験の画像とスクリプトは `C:\Users\nmrei\scratch_est\`。
- 継続 QA の検証用「既知の不良例」（実装時に判定精度の確認に使う）: 2026-10-16_12-56-48 B（元に無い椅子とトートバッグ＝fabricated_object）、12-43-51 B（元に無い椅子・ジャケット、浮いたノート PC＝fabricated_object / floating）、14-21-09 A（顔の肌・髪に格子状ノイズ＝grid/anatomy）、14-24-41 B（持っていたマイクが消えた＝missing_object）、14-30-xx C（td-…-75: 人物が右寄りの元位置から中央へ移動し正面の顔を新規に描画＝scale/position、スウェットの胸に元に無いワッペン＝fabricated_object、毛先が赤く強く髪が短め＝hair_mismatch の境界）、-67 B（短い黒髪が肩より長く＝hair_mismatch）。
- extras の表示文修正（14:29:05 再起動、直前の撮影完了を確認してから）: 主語を含む extra（誰か/どちら/みんな/二人…、「人・人物・男性・女性・さん」+が/は）は「〈人物〉が」を置かず原文を終止形に整える（例「25秒前、どちらかの人がはしゃいでいる。」）、主語なしの辞書外 extra は述語を「〜ている」に正規化。-75 で TD のパネルと 4 画面字幕の両方で正しい表示を確認。extras は辞書（25 語）＋テンプレート方式（画像なし）に変更済み（14:23:36 再起動。この再起動は生成中の撮影を 1 件止めた＝手順不備。以後は直前の撮影完了を必ず確認）。
- 4 画面の情報オーバーレイ（ユーザー指示、原文「四画面に、情報をオーバーレイするモードをつくって。２種類の情報をＯＮＯＦＦ … B Future +30s とかの部分 … 画面の左上。プロンプトは、画面の下のほうに、字幕的な感じで」、ノート側セッションが実施）: 新規 `touchdesigner/td_display_overlay.py`。各 display_* の直前（switch → display_*）に Text TOP（ラベル用と字幕用、各 影+本体の 2 枚）を挟み、文字も画像と一緒にフェード、window1..4 の winop と display_map は不変。文字は scene_text の各パネル（lb/tx）を式で参照（display_c → p_past、display_now → p_now）。/project1 の Display ページにトグル `Overlaylabel`（左上のラベル「B FUTURE +30 s」、パネル色）と `Overlayprompt`（下部の字幕）、初期値 ON、OFF で文字が空になり画像はそのまま。TD 左列に「ラベル: あり/なし」「字幕: あり/なし」ボタン（y=67）、cost_display は y91/h16/12pt、SHOW 行は y109/h22 に詰めた。`build()` は idempotent、`remove()` で元に戻せる。リポジトリに反映済み。
- 表示の保持（ユーザー指示、原文「ずーと表示して新しい画像に更新するタイミングで、一瞬でまっくらにして、そこから徐々にフェイドイン」、ノート側セッションが実施）: `td_display_integration.py` の `show()` から「hold_time 秒後に自動で暗転」を廃止し表示し続ける。新しいバッチが来たときだけ瞬時に黒（fade_lag lag2=0）にして 5 秒でフェードイン（lag1=5）。これまで 10 秒で消えていたのは listener の `start_display_exec` に `cancel_pending()` が無かったため（今回の変更で無関係に）。リポジトリに反映済み。ノートの 4 出力ウィンドウは現在テスト用の小ウィンドウ（384x216、横一列）。
- G-13 髪型・髪色を変えない（ユーザー原文「ガイドラインに、髪型、髪の色を変えないように指示して。」、固定ルール）: USER_GUIDELINES.md に追記し、画像プロンプト・負のプロンプト・VLM 指示に反映（サーバー側、実装中）。QA 項目に髪型・髪色の一致を追加予定。
- ログ基盤が稼働（13:56 ごろ再起動）: logs/capture-events.jsonl、GET /api/events（一覧・1 件・summary）、POST /api/display-log（TD からの表示割り当てを events に結合）、ビューア http://100.66.171.99:3000/logs（`server/events/viewer.html`、.gitignore の logs/ を避けるため server/logs/ ではない）。過去分は scripts/backfill-capture-events.ts で 10-15 以降を取り込み済み（今朝の 284 件失敗を含む）。
- 人物検出の見逃しの原因確定と修正（14:09:18 再起動）: describePeople の num_predict=160 で 3 人分の JSON が切れ（done_reason=length）、解析失敗を無人扱いしていた。修正: 上限 512・出力を短く、length/解析失敗は null（不明）として無人経路に入れない、guard.detector に done_reason を記録、extras の合成条件を「検出器 OR VLM の文で有人」に、履歴の hasPerson も同判定。-66/-67 で extras gen_b が synthesized=true を確認。
- **ログビューア（10-16 13:52 再起動で反映、未コミット）**: ブラウザで `http://100.66.171.99:3000/logs`（この PC は 127.0.0.1:3000/logs）。10 秒自動更新。上段=稼働状況・最後の撮影・今日の成否と費用、本体=撮影ごとの段別タイムライン + バッジ、行を開くと画像・プロンプト・エラー・表示先履歴、連続した同種の失敗は 1 行に集約。
- 構造化ログ: `logs/capture-events.jsonl`（1 撮影＝開始行＋終了行、読む側は captureId ごとに合成。失敗・キャンセルも必ず残る。費用は usage.jsonl の captureId 集計）。実装 `server/events/captureEvents.ts`・`routes.ts`、ビューア `server/events/viewer.html`、記録は server.ts の /api/generate。
- API: `GET /api/events?limit&before&failedOnly&extras&people&gemini&group`、`GET /api/events/:captureId`（prompts.json 同梱）、`GET /api/events/summary?day=`、`GET /api/events/:captureId/image/:now|a|b|c`（アーカイブ画像）、`POST /api/display-log`（TD の表示先。400=captureId なし・不正）。表示先は `logs/display-log.jsonl` と events の `displays[]` に残る。
- 過去分: `npx tsx scripts/backfill-capture-events.ts [--since 2026-10-15] [--dry-run]`（アーカイブ prompts.json と server.log の [capture] failed から。再実行しても重複しない）。10-16 に実行: 成功 504・失敗 287・キャンセル 6（03:50〜09:19 の VLM 接続失敗連続はビューアで 1 行に集約）。
- 制約: 取り込み分の失敗は段が「計画」固定（アーカイブに段の記録がない）、検出+記述の所要は無い。再起動で中断した撮影は 15 分後に「中断(失敗)」表示。画像は人が写るので repo にサンプルなし。
- 人物検出の見逃し（13:43〜13:48 の -55/-56/-57: 元フレームに 2〜3 人いるのに describePeople が people=[] → 無人経路で extras が毎回捨てられ、履歴の hasPerson=false で要約も「無人」と誤った。ユーザー「いま、追加指示がまったくきいてない？」）。対策（サーバー側、実装中・最優先）: 検出器が無人でも VLM の scene_description/observation に人物がいれば有人扱い（occupancySource='text-only'、食い違いは [guard] に記録）、無人経路は両方が無人のときだけ。検出指示を「画面端で切れた・横顔・後ろ姿・部分的な人物も数える」に強化し縮小長辺を上げて精度確認。履歴の hasPerson も「検出器 OR VLM の文」で決め、既存行も読み込み時に再計算。腕の動作（G-11）は語の一致でなく短い yes/no 呼び出しで意味判定。capture.saved の payload に `extrasStatus` {gen_x: 'applied…' | 'ignored: frame empty'} を追加（理由文字列を増やすときは日本語訳も決める）。**TD 側は実装済み**（`td_scene_text.py`、ノート）: extrasStatus が 'ignored: frame empty' なら該当欄の「継続」見出しの左にオレンジの小さな字で「無人のため未使用」、未知の理由は「<reason> 未使用」、撮影ごとに消す。リポジトリに反映済み。
- **ユーザーガイドライン（プロンプト生成の固定制約）を `rulebook/USER_GUIDELINES.md` に集約**（ユーザー指示、原文「そういうのも、プロンプト生成のためのガイドライン、にいれていって」）: G-01〜G-10（人物を勝手に出さない／直近の人物は後ろ姿で同じ服装／無人なら人の動作の extras は無効／動作は写っている本人・体の一部を物から生やさない／extras は主な出来事として必ず反映／手前の物は実寸／物は妥当な場所・勝手に足さない／無人時は環境的変化のみ／表示文はシンプル・エンジン用は詳細／自然さの基本制約）と運用 R-01〜R-03（テスト撮影の赤帯、自動改善の方針、ガイドラインの蓄積）。各項目に原文・日付・反映先・エンジン用の文。**自動改善はこの文書の項目を変更・削除しない。新しいユーザー判断はその都度ここに追記する。** /logs での一覧表示は QA/ルールブックのカードで実装。
- 継続 QA とルールブック（ユーザー依頼、原文「画像がおかしいかおかしくないかの判断は、並行してずっと QWEN で走らせて。で、プロンプト生成する際のルールを、改善し続けて。いきあたりばったりでそのときそのときだけ修正するんじゃなくて。TD に出てるプロンプトはシンプルだけど、生成エンジンに渡すプロンプトは、もっと複雑なはず」）。**運用方針（ユーザー判断、原文「自動で反映し続けて。こまったら聞いて。」）**: 改善提案は人の確認を待たず自動適用して版を上げる。ただし (1) 不良率が前の版より悪化したら自動で前の版に戻す、(2) 1 回の更新で変える項目は少数にとどめ変更内容を /logs に残す、(3) 作品の表現そのものに関わる変更（変化の大きさ、人物を出すかどうか、トーン）や同じ不良が何版も改善しないときは自動適用せず、ノート側セッション経由でユーザーに聞く。計画: 生成画像を撮影の合間にローカル Qwen で検査（JSON {ok, score, defects[{type, where, note}]}、固定分類）、結果を logs/qa-local.jsonl・prompts.json・/logs に記録、固定制約・テンプレート・ガードを rulebook/rulebook.v<N>.json に集約し各撮影に rulebookVersion を記録、N 撮影ごとに集計 → 自動更新 → 不良率で検証 → 悪化なら自動ロールバック。**サーバー側は未着手（カード「継続 QA(Qwen)とルールブックの自動改善」）。**
- すぐ直すもの（ユーザー「直してもらって」、サーバー側で対応中）: td-…-35 の Gen_b で元写真に無い大きな椅子と白いトートバッグが足された（ガードと配置制約のすり抜け。原因調査中）。extras の表示文「30秒後、写っている人物は立ち上がってる。」を具体化英文の日本語訳に。
- backend 表示を本文先頭の行から枠右上の文字アイコンに変更（ユーザー指示、ノート側セッションが実施、保存 `integrated-msi.26.toe`）: `td_scene_text.py` の各パネルのタイトル行右上に `ic_v`（左＝認識）と `ic_g`（右＝生成）、16x14 の枠付き 1 文字。NOW は認識の 1 つだけを右端に。文字は `icon_letter(backend, model)`: 'gemini' を含めば G（青）、'qwen' を含めば Q（灰白）、それ以外 '?'。payload に値が無ければ非表示。`on_capture_payload` で `set_icons(key, payload, image)` を呼び、本文には backend の行を付けない（`backend_line()` / `_with_backend()` は未使用で残置）。リポジトリに反映済み。
- T DISTANCE A/B/C スライダーに原点 0 の縦線（ユーザー指示、ノート TD、.toe 内のみで py 変更なし、保存 `integrated-msi.25.toe`）: `/project1/dist_zero_line`（containerCOMP、白、alpha 0.55、x143、w2、y366..454 = slider_dist_c の下端〜slider1 の上端、layer 5）と `/project1/dist_zero_lbl`（Text COMP「0」、x134、y454、20x12、fontsize 9）。位置は td_scene_distance の写像（u=0.5 が符号の境目）に合わせスライダー中央（x104+80/2=144）。
- Cone 図の挙動変更（ユーザー指示、ノート側セッションが実施、保存 `integrated-msi.24.toe`）: 新しい撮影が始まっても A/B/C を `_set_movie(key,'')` で消さず、前回の画像を表示したまま新しい画像が届いた枝から差し替える（NOW は従来どおり撮影フレームに即切替）。生成中で未着の枝の明るさ（uS*.z）を 0.1+0.25*pulse → pulse（0〜1）にし、前回の画像の上で枠と線がはっきり点滅する。`td_cone_viz.py` はリポジトリに反映済み。
- 履歴サマリーの経過時間をサーバー計算に変更（12:09 ごろ再起動。手順ミスでサーバーが約 2 分 20 秒停止、その間のタイマー撮影 1 回分が失敗/記録のみの可能性）: 4B には出来事の流れだけ（150 字以内、分数なし）を書かせ、末尾に hasPerson の遷移から計算した現状 1 文（例「12:02から現在まで14分間、無人。」）をサーバーが付け、残った「〜分間」は除去、全体 200 字以内。GET /api/history-summary は {summary, body, since, hasPerson, updatedAt, captureId}。実撮影 2 回で実時刻と一致を確認。
- 「これまで」の状況サマリー（ユーザー依頼「NOW の状況認識の下に、これまでの状況のサマリーを表示して更新をつづけて。200 字程度」）。**TD 側はノートで実装済み**（`td_scene_text.py`、保存 `integrated-msi.23.toe`）: NOW パネルの下半分に読み取り専用の 'sum'（見出し「これまで」、スクロール可）。`on_capture_payload` で payload.historySummary があれば `set_summary()` で更新、空なら前の文を残す。NOW の tx は上半分に縮小。起動時の GET /api/history-summary 読み込みは未実装（次の capture.saved で埋まる）。リポジトリに反映済み。**サーバー側は実装中**: 撮影ごとに scene history のまとめからローカル Ollama の短い呼び出し 1 回（画像なし、無料。認識が Gemini でも local）で日本語 200 字程度を作り、失敗時は計算だけの定型文。画像生成と並行して作り、間に合わなければ前回分を使い回す（時間を伸ばさない）。payload（capture.saved 3 通とも同じ文）に `historySummary`、GET /api/history-summary → {summary, updatedAt, captureId}、POST /api/reset-history でサマリーも空に。test:true の撮影では会場の履歴を更新せず前回の会場サマリーを載せる。保存 logs/history-summary.json。
- **テスト撮影は「テスト画像使用中」と分かる形で展示 TD に送る**（経緯: ユーザー報告「なんで昔の生成画像がでてきてるの？」= デスクトップ側のテスト撮影 extras-test-8 の capture.saved が既定の通知先＝ノートの展示 TD（UDP 9991）に届き、会場の表示を古いテスト画像で上書き。その後のユーザー判断（原文）「過去の、良さそうな画像で、いろいろテストするのはいいよ。その代わり、テスト画像使用中、という風に表示しておいて」）。方針: `/api/generate` に `test:true`（captureId は td- で始めない、例 extras-test-…）を付けた撮影は、UDP は送るが payload に `test:true` と `source:'test'` を入れる（サーバー側実装中）。`captures/latest.json` / `latest_scenes.json` は更新しない、履歴にも書かない、アーカイブには source='test' で残す。TD 側（`td_scene_text.py`、保存 `integrated-msi.22.toe`）は payload が test:true / source=='test' / captureId が 'td-' で始まらないとき、出力画像の列の上端に赤帯「テスト画像使用中（captureId）」を出し、次に会場の撮影（td-…）が来たら消す。**注意: テスト撮影の実行中は TD のタイマー撮影が「生成中」扱いで記録のみになるので、テストは間隔を空けて短時間でまとめる。** `td_scene_text.py` はリポジトリに反映済み。
- ユーザー確認済み（原文「人がいない場合は、『帰ろうとしている』は無効でいいからね」）: 無人判定のときは人の動作の extra を無視するルールを維持。
- 追加指示（sceneExtras）の「継続／次回のみ」2 欄化（ユーザー指示、ノート側セッションが実施、保存 `integrated-msi.21.toe`）: `td_scene_text.py` はパネル C/A/B の下半分を 2 欄に分割（上 'in'=継続、下 'in1'=次回のみ、背景を少し暗く、右上に小見出し）。`get_extras(consume=False)` は両方を ' / ' で連結、`consume=True` は in1 を読んだ後に空にする。`set_extras(..., once=True)` で in1 に入れられる。INPUT_PLACEHOLDER は廃止。`td_native_capture.py` の `get_scene_params()` は `get_extras(consume=True)` を呼ぶ（古い td_scene_text には TypeError 時のフォールバック）。**注意: get_scene_params() を呼ぶたびに「次回のみ」が消えるので、確認目的で呼ばないこと。** サーバー側の変更は不要（従来どおり sceneExtras {gen_a: "…"}、連結された 1 文字列も 1 つの指示として扱う）。両 py はリポジトリに反映済み。
- extras の反映判定の廃止（ユーザー報告「A、追加指示がきいてない」。td-…-18/-19 で 4B の yes/no 判定が reflected=true と誤判定し再試行も合成も走らなかった）: extra のあるシーンは常にサーバーが書く方式へ変更中（extra を短い呼び出しで「写っている本人がする具体的な英文 1 文」に具体化して prediction_prompt に採用、表示文は「30秒後、写っている人物は〈extra〉。」をサーバーで組む。無人時は人の動作の extra を無視）。
- Gemini 切替の実機確認（ユーザー承認済み、ノートの切替ボタンで 1 回ずつ、終了後 local に戻した）: 認識のみ（td-1792117404952-15）= scenario 1.99 円 + other 0.199/0.433 円（表示用の日本語訳 2 回。認識を Gemini にすると翻訳・extras の英訳/判定も Gemini のテキスト呼び出しになる。検出・記述はローカルのまま無料）= 計 2.6 円、パネルに「［認識 Gemini gemini-3-flash-preview / 生成 ローカル …］」。生成のみ（td-1792117545132-16）= image 6.134 円 × 3、出力 1280x731、画像良好。この日の Gemini 合計 21.0 円（6 回）。
- 表示先（display）の記録: TD 側実装済み（`td_display_map.py`、保存 `integrated-msi.20.toe`）。POST `<Serverurl>/api/display-log` に {captureId, at, reason: batch|layout|window, assignments: [{display 1..4, window, source, scene, open}×4]} を、表示中の撮影が変わったとき／SHUFFLE・RESET／ウィンドウ開閉で送る。**サーバー側は未実装（404）**。構造化ログ（logs/capture-events.jsonl）・ログビューア（/logs）と一緒に実装予定（ユーザー依頼「LOG を整理してわかりやすく視覚化」「どの display に出したかも記録」）。
- 撮影ごとの VLM/画像バックエンド切替（ユーザー依頼「GEMINI に状況認識を投げるオプション、GEMINI に画像生成を投げるオプションも。その情報は生成画像の説明記述にも埋め込んで」）。**TD 側はノートで実装済み**（保存 `integrated-msi.19.toe`）: `td_native_capture.py` に BACKENDS=('local','gemini') / BACKEND_LABELS、`install_backend_parameters()`（Capture ページに `Vlmbackend` / `Imagebackend` menu、既定 local、ラベル Local / Gemini (paid)）、`get_scene_params()` が par があれば `vlmBackend` / `imageBackend` をリクエストに付ける。`td_scene_text.py` に `backend_line(payload, image)`（capture.saved の vlmBackend/vlmModel/imageBackend/imageModel から「［認識 Gemini gemini-3-flash-preview / 生成 ローカル qwen-image-edit-2511］」の行を各パネル本文の先頭に付ける。NOW は認識の行のみ。フィールドが無ければ何も付けない）。パネル: WORLD PARAMETER 枠内下端（y277）に `vlm_backend_btn` / `image_backend_btn`（各 126x22）+ panelexecute DAT 2 個。両 py はリポジトリに反映済み。**サーバー側は未実装**（リクエストの vlmBackend/imageBackend の受け取り、Gemini 経路での人物ガード・履歴・extras の共通化、payload/prompts.json/README/PNG tEXt への VlmBackend/ImageBackend の埋め込み。費用の目安: 認識のみ ≈ 1〜3 円、生成のみ 3 枚 ≈ 18〜19 円、両方 ≈ 20〜22 円。既定は local のまま）。
- **サーバー側実装済み（10-16 11時、未コミット）**: リクエスト `vlmBackend` / `imageBackend`（`local`|`gemini`。欠落・不正値は GENERATION_BACKEND 由来の既定: local→local/local、hybrid→gemini/local、gemini→gemini/gemini。Gemini 指定でも API キーが無ければ local に落ちる）。capture.saved と /api/generate 応答と prompts.json（トップ・各シーン）/README/PNG tEXt（VlmBackend・ImageBackend・既存 VlmModel・ImageModel）に実際に使った vlmBackend/vlmModel/imageBackend/imageModel。実装 `server/generation/backends.ts`、Gemini 認識は同じ人物ガード・人物事実・履歴・extras・日本語表示文のパイプラインに Gemini を差し込む（計画 1 回＋日本語化/extras の短い text 呼び出し。人物検出 describePeople は常にローカル Ollama）。費用の目安: 認識のみ ≈ 1〜3 円、生成のみ（3 枚）≈ 18〜19 円、両方 ≈ 20〜22 円（認識はテキスト呼び出し分が少し上乗せ）。Gemini 経路の未対応: 画像側の負のプロンプトは「must be free of: …」の正文に変換（効き方は local と同じではない）、seed なし、Gemini 実呼び出しの検証は未実施（モックのみ。実機確認はユーザーの費用確認後）。ブラウザ用 /api/predict-scenarios・/api/generate-image は従来どおり GENERATION_BACKEND の既定。
- 画面配置の再変更（ユーザー指示、ノート側セッションが実施、保存 `integrated-msi.18.toe`）: CONE の枠 `frame_selection4` を y420..688（h268）に縮小、`td_cone_viz.py` は VIZ 288,424,980x228、THUMB 72x40、AXIS_Y 120、LANE_Y 22、SLOT ±36（2 つ）/±58（3 つ）。出力画像の列 `ui_root/gen_view_*` を y284・h132（.toe 内）。シーン文の帯 `td_scene_text.py` を BOX_H 240（y40..280）、追加指示の入力 'in' は INPUT_H=(BOX_H−LABEL_H)//2=111 で状況記述と同じ高さ（multiline、wordwrap、aligny top）。両 py をリポジトリに反映済み（URL 対応 `_usable`、`get_extras` は維持）。注意: `build()` を実行するとシーン文が「—」にリセットされ、次の capture.saved で埋まる。
- FUTURE CONE を横いっぱいに拡大（ユーザー指示、ノート側セッションが実施、保存 `integrated-msi.17.toe`）。.toe: `frame_selection4` を x281・w995（y276..688 は維持）、`masterLabe5` を x284・w989、output ボタン（`masterLabel3`）を右端 x1087。`td_cone_viz.py`: VIZ 288,282,980x370、THUMB 100x56、AXIS_Y=198、X_NEAR/X_FAR=200/420、LANE_Y=34、SLOT_OFFSETS ±50/±90、シェーダーの xf/xn をハードコードから `__X_FAR__`/`__X_NEAR__` に置き換え build() で定数から埋める（URL 対応 `_usable` は維持）。リポジトリに反映済み。注意: 生成中に build() すると `_S['cur']` を None にして refresh() し直す必要がある。
- 画面配置の変更（ユーザー指示、ノート TD、.toe 内のみで py 変更なし、保存 `integrated-msi.16.toe`）: LIVE CAMERA（`ui_root/frame_selection`）と WORLD PARAMETER（`frame_selection3`）の幅を 518 → 270（x5..275）、見出し `masterLabe1` / `masterLabe4` は幅 264。ラベルを TEMPORAL DISTANCE A/B/C → T DISTANCE A/B/C（`masterLabel`、`dist_lbl_b`、`dist_lbl_c` の Widgetlabel、ラベル 5 個は幅 86）。スライダー 5 本（`slider1`、`slider_dist_b`、`slider_dist_c`、`slider2`、`slider3`）は x104・幅 80、`dist_val_a/b/c` は x188・幅 86・fontsize 10。Cone のサムネイルは Displaytiming=each でも 1 枚ずつ届いた順に入ることを確認済み。
- Cone 図の A/B/C が真っ黒になる不具合を修正（ユーザー報告、ノート側セッションが修正、保存 `integrated-msi.15.toe`）: `td_cone_viz.py` がサムネイル採用前に `os.path.exists(path)` で確認していたが、`Imagesource=url`（ノート）では path が `http://100.66.171.99:3000/captures/…` のため常に False → th_a/b/c が空（NOW は %TEMP% のローカルファイルなので表示されていた）。`_usable(path)`（http(s) URL か存在するファイルなら True）を追加し、adopt_existing の Gen/Record 判定と refresh の到着判定の 3 か所を置換。リポジトリの `touchdesigner/td_cone_viz.py` に反映済み。
- ノートの Ollama が 10-16 03:48 の応答を最後に落ちていた（ノートは再起動していない。プロセスだけ消失、終了ログなし。0.40.5 への自動更新の失敗が疑い）。03:42〜09:18 のタイマー撮影 284 件が VLM 段階で失敗（`[guard] detector+describe … error=describe failed` → `fetch failed`、local モードなので課金なし）。09:20 にノート側で Ollama を再開 → サーバー再起動なしで自動復旧（`/api/health` ollama:true）。**対策（10-16 09:2x、ユーザー許可済み、ノート側セッションが実施）: ノートにタスクスケジューラ「Ollama Watchdog」（ログオン時と 1 分ごと、wscript で run-hidden.vbs → `C:\Users\81808\tools\ollama-watchdog\ollama-watchdog.ps1`）。`/api/tags` が 2 回続けて失敗したら Ollama を止めて `OLLAMA_HOST=0.0.0.0:11434` 等を付けて起動し直す。ログは同フォルダの watchdog.log。失敗時の動作は別ポートで確認済み。外すときは `Unregister-ScheduledTask -TaskName 'Ollama Watchdog'`。Gemini フォールバックは有料のため未導入。** 復旧後の td-1792110066098-653 は capture.saved ×3 と generation.completed まで正常完了。
- 出力マップ図の配置変更（ユーザー指示、ノート TD、保存 `integrated-msi.14.toe`）: WORLD PARAMETER の下へ移し、左（A/B/C/NOW）→ 右（DISPLAY 1〜4）の横向き配置。`ui_root/display_map` は x8, y166, 268x102、`display_map_top` は 536x204（2 倍解像度）。リポジトリの `touchdesigner/td_display_map.py` をノートの v2 に差し替え済み。
- 人物ルールの確認（ユーザー判断、原文「直近10分以内にいた人を、無人の部屋に登場させてよい」）: `RECENT_PERSON_WINDOW_MIN=10` の許容ルール（直近に写っていた人物を参照画像つきで登場させる）は**ユーザー確認済みで維持**。

**2026-10-15 追記**
- presence/tone 改修（10-16 23:10 再起動）: presence は「写っている人物の動きの量と退出の可否」に再定義。高くても未知の新規人物は出さない（G-01、`presenceAllowsNewPerson` は常に false、`gemini-prompts.json` の presence 帯文を書き換え）。新規登場は直近 10 分の人物（後ろ姿）のみ。
- tone は画像プロンプトにも入る: `composeEditInstruction` が tone 帯（CALM/QUIET/LIVELY/DRAMATIC）ごとに「Amount of change:」の 1 文を追加（`ruleTexts.ts` の `TONE_IMAGE_RULES` / 無人用 `TONE_IMAGE_RULES_EMPTY`、rulebook の任意項目 `toneImage` で差し替え可、`toneImageRule()`）。無人は光の変化量だけ。LIVELY/DRAMATIC の例文から万歳・伸び・手振りを除去（G-11）。
- `logs/capture-events.jsonl` に `presence` / `tone` / `effectivePresence`（無人なら 0）を記録し、`/logs` の各行バッジに表示。テスト: `server/generation/toneImage.test.ts`、`services/sceneParams.test.ts` 更新。
- 二台のつながり表示（ユーザー指示、ノート TD）: 操作パネルの SHOW/HIDE ボタンの上に「メインPC ● / ComfyUI ● / Ollama ●」。新規 `touchdesigner/td_link_status.py`（ファイル同期 DAT `/project1/td_link_status`、`/project1/link_status` に Text COMP 3 個）。5 秒ごとに別スレッドで メインPC=`GET <Serverurl>/api/capture/status`、ComfyUI=`GET <Serverurl>/api/health` の comfyui、Ollama=`GET 127.0.0.1:11434/api/tags` を確認し、緑=OK / 赤=停止 / 灰=不明。18:32 に 3 つとも緑を確認。
- ヘルスチェック API（ユーザー指示）: `GET /api/health` → `{ok:true, comfyui, ollama, time}`。ComfyUI は `${COMFYUI_URL}/system_stats`、Ollama は `${OLLAMA_URL}/api/tags` に GET して 2 秒以内に 2xx なら true、失敗・タイムアウトは false（ok は常に true）。結果は 5 秒キャッシュ（TD の 5 秒ポーラーが生成中の ComfyUI を叩きすぎないため）。実装 `server/health/routes.ts`、テスト `server/health/health.test.ts`。
- 出力マップ図（ユーザー指示、ノート TD、保存 `integrated-msi.12.toe`）: A/B/C/NOW のどれが DISPLAY 1〜4（window1〜4）に出ているかを線で結ぶ図。新規 `touchdesigner/td_display_map.py`（ファイル同期 DAT `/project1/td_display_map`。Script TOP `/project1/display_map_top`（1340x128、cv2 で毎フレーム描画）の callbacks を兼ねる。表示は `ui_root/display_map`（containerCOMP、x540、y280、670x64、Future Cone 枠内の下の空き）。`build()` で両方を作る、idempotent）。`window*.par.winop` を読むので SHUFFLE/RESET に追従。ウィンドウが閉じているときは DISPLAY ラベルと線を暗く表示。
- LIVE CAMERA の左右反転を解除（ユーザー指示、ノート TD、保存 `integrated-msi.11.toe`）: `/project1/transform1` の sx を −1 → 1（camera→fit1→transform1→cache1→live）。live の向きが撮影して送る写真・生成画像と一致し、`moviefileout1` の録画も反転なしになる。
- フェードインの切替（ユーザー指示、ノート TD、保存 `integrated-msi.10.toe`）: `display_now/a/b/c` の Level TOP `brightness2` にはもともと `op('fade_lag')['chan1']` の式があった（配線は既存）。ノートの toe に `fade_state` が無かったため fade_lag=0 で display_* が真っ黒になっていた（`install_display_sync()` で fade_state を作っても値は 0 のまま。既存 fade_lag は lag1=5.0 / lag2=0.0 で、install は既存を上書きしない）。対応: brightness2 の式を「Fademode=='fade_state' なら fade_lag、それ以外は fade_state（即時）」に変更、`fade_state`=1、`Fademode` の menuLabels を legacy_timer2=フェードなし（すぐ表示）/ fade_state=フェードイン に変更。パネル: `display_timing_btn` を幅 132・ラベル「表示: 3枚一斉／1枚ずつ」に、その右（x144, y40, 132x24）に `fade_mode_btn` + `fade_mode_exec`（Fademode を切替、フェードなしにするときは fade_state=1）。確認済み: フェードインで fade_state 0→1 のとき brightness2 が段階的に 0.76 まで上がる。**既定はフェードなし**。
- 表示連携の取り込み完了（ノート TD、保存 `integrated-msi.9.toe`、15:05）: `install_display_sync()` で DAT 5 個・`fade_state`・`fade_lag`・`Fademode` を作成済み。**`Fademode` は暫定で legacy_timer2**（`fade_lag` を表示側に未配線のため。配線案: level1〜4 の Level TOP の Opacity に `fade_lag` をエクスポート → manual 撮影 1 回で確認 → fade_state に切替 → Ctrl+S）。listener にはノート側で `_show_display_windows()` を追加（名前に反してウィンドウは開かない: `/project1/td_display_integration` があれば `show()` を呼び、`fade_state`=1 にして `hold_time`（holdsec=10 秒）後に `fade_out()`（fade_state=0）を予約するだけ。両フェードモード共通で呼ばれる）。**影響: Fademode がフェードなし（brightness2=fade_state 直結）のときは、バッチ完了ごとに 10 秒表示 → 即黒になる。フェードイン側は `_trigger_display_fade_in` が自動フェードアウトを止めるので表示されたまま。この「10 秒で消える」動きを残すかはユーザー確認中。** `td_display_integration.on_start()` は TD 起動時に `Capturemode` を manual にして `hide()` する → **TD を再起動するとタイマー撮影は止まり画面は黒になる**（展示前に Capturemode と表示を手で戻すこと）。SHUFFLE は動作（割当例: window1=display_b、window2=display_now、window3=display_c、window4=display_a）だが window1〜4 は閉じているため見た目は変わらない。リポジトリの `td_capture_listener.py` はこの版（BOM なし）に揃えた。`td_display_integration.py` も `touchdesigner/` に追加（`claude-code\td-integration-2026-10-14\laptop-transfer` の zip 同梱版）。**py は UTF-8 BOM なしで保存すること**（BOM 付きだと TD で先頭行が壊れることがある）。
- sceneExtras の人物動作修正をノートの実写真で確認（td-1792044198969-53、C「両手を上げて喜んでる」）: 写っている人物が立ち上がって両手を挙げ、腕は本人に付いた。ただし元写真で顔が見えていない人物の顔は生成されたもの。
- 上部バーのカウントダウン／経過時間表示（ユーザー指示、ノート側セッションが実施、保存は `integrated-msi.7.toe`）: 新規 `touchdesigner/td_countdown.py`（ファイル同期 DAT `/project1/td_countdown`。`build()` が `/project1/mode_extras/countdown`（Text COMP、x540、w324）を作り `mode_extras/msg` の幅を 300 に縮める。text の式は `op('/project1/td_countdown').module.text(int(absTime.seconds))`）。表示: 待機中「次の生成まで m:ss」（timer=nextTimerTickIn、chain=chainDueIn）、生成中「生成中 m:ss 経過（n/3）」（busyFor と listener の PENDING）、在席ゲート waiting/paused は「人物待ち」「無人のため停止中」、manual は「手動モード」。`td_native_capture.py` の status() と listener の PENDING を読むだけで、他は変更なし。
- ノート TD の画面配置変更（ユーザー指示、ノート側セッションが実施、保存は `integrated-msi.6.toe`）: 左上は LIVE CAMERA（`ui_root/frame_selection` の背景 TOP = `/project1/live`、`masterLabe1` の Widgetlabel を「LIVE CAMERA」。重なっていた `/project1/radioicons`(Part1〜3) と `ui_root/text1`(current) は display=off、削除はしていない）。CUSTOM PROMPT は削除（`/project1/fieldTextArea`、`ui_root/frame_selection1`、`ui_root/masterLabe2`。他からの参照なしを確認済み）。WORLD PARAMETER は左側 x5..523 / y272..502（スライダー類 dx=−529, dy=−186）。FUTURE CONE は `frame_selection4` を y276..688 に伸ばし見出しを y658 へ、`td_cone_viz.py` の VIZ_X/VIZ_Y を 627/350 に変更（ノートから受け取ってリポジトリへ反映すること）。右端の縦列 `container6`(layout1) は display=off にし、代わりに `ui_root/gen_view_now/c/a/b`（containerCOMP、背景 TOP は switch0/switch3/switch1/switch2）を各プロンプト欄の真上 y136..268 に配置。
- 9月版の TD 表示連携 3 点を `td_capture_listener.py` に移植（HTTP は別スレッド、純関数は `touchdesigner/td_display_sync.py`、`python -I tests/test_display_sync.py`）: (1) バッチ完了時に /project1 の `scenario_current`・`observation_current`・`history_current`(time(JST)/captureId/observation/hasPerson、新しい順)・`scenario_latest`・`action_log` の DAT を更新（GET /api/latest-prediction と /api/action-history）、(2) 表示フェードイン: `fade_state`(Constant CHOP) → `fade_lag`(Lag CHOP 0.8/0.8 s)、同じ captureId は 1 回、`start_display_exec.cancel_pending()` も呼ぶ、(3) `reset_history()`（POST /api/reset-history、成功で TD 側のバッチ・フェード・DAT・シーン文をクリア。`td_capture_panel_controls.reset_history()` からも呼べる）。
- 切替: /project1 の Display ページ `Fademode`（legacy_timer2 / fade_state、既定 fade_state。par が無い・fade_state が無い間は従来の timer2 方式のまま）。
- 適用: デスクトップはファイル同期 DAT（`td_display_sync.py` を新しい DAT `/project1/td_display_sync` として追加）。ノートは py 3 つ（td_capture_listener・td_display_sync・td_capture_panel_controls）をコピー → `op('/project1/td_capture_listener').module.install_display_sync()`（DAT 名は環境に合わせる）→ `fade_lag` の出力を表示用 COMP の Alpha/opacity にエクスポート → Ctrl+S。
- キー割当: Keyboard In の callback（または既存パネルボタン）から `op('/project1/td_capture_panel_controls').module.reset_history()`（Stream Deck の Shift+Ctrl+Alt+n 用）。未検証: TD 実機での動作（TD 外のテストのみ）。
- ノート TD（`integrated-msi.3.toe`、ノートの `~/Documents/SpeculativeMemory-msi/SpeculativeMemory`）に 13:00 ごろ取り込み済み: 在席ゲート（`/project1/td_presence_gate` のファイル同期 DAT + パラメータ5個、`Startonperson` はまだ off）、sceneExtras の入力枠（パネル C/A/B の下に1行 Text COMP、`td_scene_text.py` の `get_extras()`/`set_extras()`、`td_native_capture.py` が `values['sceneExtras']` に載せる。入力は消すまで残る）、左上のライブカメラ表示の作り直し（`ui_root/frame_selection` の背景 TOP を `/project1/live`、topfill=best。見出しは「FRAME SELECION」のまま）。リポジトリの `touchdesigner/td_native_capture.py` / `td_scene_text.py` はノートからマージ済みの版を 13:05 に反映。
- 在席ゲート（人物を検出したら撮影開始／無人が続いたら停止）: /project1 の Capture ページに `Startonperson`（toggle、既定 off）・`Idlestopsec`（0〜3600、既定 300、0=止めない）・`Presencepollsec`（1〜60、既定 5）・`Presencestate`（off/waiting/active/paused、読み取り専用）・`Lastpersonat`。timer/chain かつ Startonperson on のときだけ働き、Capturemode は変えない。manual は影響なし。
- 判定は `touchdesigner/td_presence_gate.py`（純関数、`python -I tests/test_presence_gate.py`）、実行は `td_native_capture.py`。サーバー: `POST /api/detect-person`（`server/presence/`、結果は `logs/presence.jsonl`、画像は保存しない）。テスト 05/08/10/12 は 4/4 正解、約 1.4 秒（VLM 計画中は初回 3 秒前後）。
- 適用手順: py を TD に反映（デスクトップはファイル同期 DAT。ノートは `td_native_capture.py` と `td_presence_gate.py` を同じフォルダへコピーして DAT を再読込）→ textport で `op('/project1/td_native_capture').module.install_presence_parameters()`（`install_capture_parameters()` でも可）→ Startonperson を on。パラメータは .toe に保存して初めて残る（Ctrl+S）。縮小送信は TD の Python に PIL があるときだけ（無ければ元サイズ送信）。
- 人物捏造ガード（無人の部屋で VLM が人物を書く問題、12:23 以降）: `server/generation/scenarioGuard.ts`。scene_description に人物語が無いのにシナリオに人物語があれば捏造と判定し、`planScenariosLocal` が最大 `VLM_GUARD_RETRIES`（既定 3）回再試行、なお捏造なら「部屋は空のまま光だけ変わる」安全な文に差し替える（gemini/hybrid は再試行せず差し替えのみ）。
- 無人判定のとき server.ts は ComfyUI への presence を 0 にし、composeEditInstruction が「人物・手・影を足さない」を追加。JSON_INSTRUCTION も「無人なら人物に一切言及しない／人物の例文は人物がいる場合のみ」に変更。
- 記録: logs/server.log の `[guard]` 行と、生成アーカイブ `<ID>_prompts.json` の `vlm.guard`（unoccupied / attempts / fabricatedPerAttempt / replaced）。
- 履歴機能（9月版の復活）: `server/history/sceneHistory.ts`。撮影ごとの観測（VLM の scene_description を再利用）を `logs/scene-history.jsonl`（time/captureId/sceneDescription/hasPerson/observation/imageFile）に追記し、直近 `SCENE_HISTORY_LIMIT`(8)件・`SCENE_HISTORY_WINDOW_MIN`(30分)を `gemini-prompts.json` の historyIntroTemplate でシナリオ計画に注入（`SCENE_HISTORY_ENABLED=false` で無効）。
- API: `GET /api/action-history?limit=N`、`POST /api/reset-history`（logs/archive/ へ東京時刻付きで退避）、`GET /api/latest-prediction`。使用件数・観測は prompts.json の `vlm.history` と `[history]` ログに残る。
- 人物ルール: 直近 `RECENT_PERSON_WINDOW_MIN`(10分) に人物が写っていればシナリオの人物は許容し、その撮影フレームを参照画像（faceImage）として渡す。ずっと無人なら人物を出さない（上記 guard）。
- sceneExtras: `/api/generate` の body.sceneExtras `{gen_a, gen_b, gen_c}`（各200文字で切る、空欄・非文字列は無視。`server/generation/sceneExtras.ts`）。VLM 計画プロンプトに「Scenario N (gen_x) MUST include: …」を該当シーンだけ追加し、画像プロンプト末尾に「Also: …」を追加。
- 無人で人物を指定された extra は guard が優先（画像側の Also も外し、`[extras]` ログに理由）。アーカイブ prompts.json の各シーンに `sceneExtra`。
- テスト撮影の手順: `/api/generate` の body に `recordHistory:false`（または `test:true`、captureId に "test" を含める）を付けると履歴を読まず・書かない（人物ありのテスト画像で本番の「直近の人物」判定が汚れるのを防ぐ）。
- テスト撮影（修正）: body に `test:true`（または captureId に "test"）を付ける。UDP は test:true / source:'test' 付きで送られ（TD は「テスト画像使用中」を表示）、captures/latest*.json・履歴・会場サマリーは更新されない。`notify:false` で UDP を一切送らない。アーカイブは source=test。captureId は td- で始めない。
- 人物の見落とし対策: `/api/generate` は VLM 計画の前に detectPerson（既存）→ person=true なら `describePeople`（短い画像呼び出し）を実行し、計画プロンプト先頭に GROUND TRUTH を注入（`server/generation/peopleDescribe.ts`）。計画は最大 `VLM_MAX_PLAN_ATTEMPTS`(3) 回・`VLM_TIME_BUDGET_MS`(40000) まで再試行し、それでも「無人/No change」なら人物の記述からサーバーが合成（guard.synthesized、extras は guard.extras[key].synthesized）。
- 履歴サマリー（NOW の下、約200字）: `server/history/historySummary.ts`。履歴から日本語要約を Ollama 1 回で作り（失敗時は定型文）、ComfyUI と並行して生成。capture.saved の `historySummary`、`GET /api/history-summary`、`logs/history-summary.json`、reset-history で空になる。
- 時間短縮（10-15 夜）: 検出と記述は describePeople 1 回に統合（people 空=無人、/api/generate は detectPerson を呼ばない）。無人は計画 1 回→弱い/失敗はサーバー側テンプレート、人ありは最大 2 回・予算 25 秒。VLM フェーズ中は `VLM_PHASE_KEEP_ALIVE`(2m) でモデルを保持し、最後の翻訳呼び出しで解放。実測: 無人 約100秒、人あり 約110秒。
- 生成アーカイブ（追加処理・失敗しても生成は止まらない）: 撮影ごとに `GENERATION_ARCHIVE_DIR`（既定 `C:\Users\nmrei\GitHub\speculative-memory_data\generations`、公開リポジトリ外。`.env.local` / `.env.example`）の `<YYYY-MM-DD>/<生成ID>/` へ保存。生成ID = 元画像 `captures/record_<ID>.jpg` の撮影時刻 `YYYY-MM-DD_HH-MM-SS`。
- ファイル: `<ID>_NOW.jpg`（元画像）、`<ID>_A.png`/`_B`/`_C`…（gen_a から順）、`<ID>_prompts.json`（VLM 全文・生応答・各シーンの画像プロンプト全文/seed/所要時間）、`<ID>_README.txt`（人用要約）。
- 各 PNG に tEXt（日本語など非 Latin-1 は iTXt）で GenerationId / Scene / DistanceSec / PredictionPrompt / ImagePrompt / NegativePrompt / VlmModel / ImageModel 等を埋め込み（`server/archive/`）。gemini/hybrid は VLM 全文・画像プロンプトが null（未記録）。
- ユーザー指示（10-15）: Node サーバー / ComfyUI / Ollama の起動・停止・再起動、`.env.local` の設定変更は確認なしで実行してよい。確認が必要なのは「削除」「git commit/push」「公開」のみ。
- 既存の課金ルール（有料実行は目的と費用を確認、報告に費用を記載）はそのまま有効。
- ローカルモードの発見: qwen3-vl:4b（Ollama 0.40.4）は `think:false` を無視して思考し続け、response が空になる。ノートに `qwen3-vl:4b-instruct` を入れ、`.env.local` の `VLM_MODEL` を差し替えて解決（10-15 03:38 再起動）。`vlmClient.ts` は `VLM_NUM_CTX`（既定 8192）/`VLM_NUM_PREDICT`（既定 2048）と、0件時の診断ログ（done_reason / eval / response 先頭）を追加。
- ComfyUI 本体が 10-07 更新（commit 0752bcb2、Linear.forward に `input_act` 等の引数追加）で、1月版 ComfyUI-GGUF（`C:\Users\nmrei\Documents\ComfyUI\custom_nodes\ComfyUI-GGUF\ops.py`）が KSampler で TypeError。上流に修正が無いため、`GGMLOps.Linear.forward_ggml_cast_weights` に互換パッチ（8行、未コミットの差分）を当て、`POST /api/v2/manager/reboot` で ComfyUI を再起動。GGUF ノードを更新・再インストールするとパッチが消えるので注意。
- 10-15 06:08 にテスト画像 05 で local モード撮影を実行し、110秒で3枚完成（VLM 約35秒 + 画像 約25秒×3、0円）。4B instruct は `prediction_prompt` を日本語で返す（画像は従う。英語に揃えるかは今後の調整項目）。

**2026-10-07 23時の追記（ここが最新。下と食い違うときはこちらが正しい）**
- PC は 2026-10-07 12:48 に再起動された。**Node サーバー（3000）も ComfyUI（8000）も停止中**。ComfyUI は Comfy Desktop アプリからユーザーが起動、サーバーはユーザー許可のあと独立プロセスで起動（`Invoke-CimMethod Win32_Process Create` で起動すると Claude の作業終了後も残る。`Start-Process` やサブエージェント起動は落ちた前例あり）。起動スクリプト: `scripts/start-server-current.ps1` / `stop-server.ps1`
- サーバー再起動で初めて効くもの: 二台構成対応（`PUBLIC_BASE_URL`、`notifyToSender`/`notifyHost`、`nowUrl`）。Tone 4段階・「写っている物だけ」・シーン別距離は 10-06 10:08 の実撮影で動作確認済み（距離 +30/+30/+150 のテスト、6.18円。ただし C=+2分30秒「人が席を立つ」は画像に反映されず、人が座ったまま。原因候補: 2分以上の画像指示「変えるのは人の姿勢と位置だけ」が「人を消す」と矛盾）
- TD（`ensyutu_part2.toe`）の最終保存は 10-06 10:08。保存に入っているもの: 状況説明4枠、Manual/Auto・間隔、generate ボタン上段、TEMPORAL DISTANCE A/B/C、Cone 図のスライダー追従（`td_cone_viz.py`: 位置・枝・ラベルは常にスライダー値、撮影時の距離が違うときだけ小さく「撮影時 −30 s」、下は −10 m…NOW…+10 m の時間軸）。**保存に入らず消えたもの: 左上のライブカメラ表示（`live_cam_src`/`live_cam_view`、見出し LIVE CAMERA）→ 作り直しが必要。** `tmp_probe_cam`（余分な videodevin）は残っている→削除候補
- 二台構成の TD 側（`td_native_capture.py` / `td_capture_listener.py` の Network ページ `Serverurl` / `Imagesource` / `Notifyhost`）は repo の .py だけ更新済みで、**TD の DAT 同期・`install_network_parameters()` 実行は未実施**。手順は `docs/TWO-MACHINE-SETUP.md`
- TD の MCP は現在 `speculative-memory_demo-sep\touchdesigner\TimeWarp_0710.toe` のインスタンスにつながっている（先に開いた方が 9988 を取る）。改良版を MCP で触るには TimeWarp を閉じて Reconnect
- **9月展示版の正体**: `C:\Users\nmrei\GitHub\speculative-memory_demo-sep\` は 10-06 12:21 にユーザーが別PC（81808）の版で上書きしたもので、git の 09-05 コミットとは別物。ブラウザが直接 Gemini を呼び、画像も `gemini-2.5-flash-image`（1枚 $0.039、1撮影 約18〜19円、料金記録なし）。09-19 ごろの「行動履歴」機能（action_log.jsonl→次回の予測に投入）あり。`td_capture_listener.py` 52-53行に別PC の絶対パス。昨日この版で7回生成（約130円、usage.jsonl には載らない）。worktree の `.git` が消えていたのを 10-07 に修復済み。コミット手順は同フォルダの `COMMIT-DEMO-SEP.md`（ユーザーが実行）。昨日書いた `README-DEMO-SEP.md` と `start-server-sep.ps1` は 09-05 版前提で内容が古い（README は消えている）
- TD 2バリエーション比較（10-07）: 改良版 = 生成の仕組みが新しい（native capture、距離/Tone/料金/Cone）。TimeWarp = 表示の演出（フェードイン/アウト、ホールド10秒、シャッフル、配置リセット、Stream Deck s/h/r）。統合方針の案: 改良版を土台に、TimeWarp から `fade_state`/`fade_lag`/`hold_time`/`fade_driver1`、`start_display_btn`/`hide_display_btn`/`shuffle_btn`/`reset_layout_btn` と各 `*_exec`、`keyboardin_streamdeck*` を複製し、level1〜4 の明るさと window の割り当てを手で配線。ユーザーの決定待ち（土台、映像入力 C920 か WebRTC か、シャッフルに残像合成を含めるか、モニター4台の割り当て）
- モニター（10-07 確認）: 4台すべて RTX 4090 直結（DELL HDMI、FHD×2 DP、SONY TV DP）、Windows は拡張で座標 0/2560/4457/6377。「4画面目がメインの複製」は OS ではなく TD の window 割り当ての可能性が高い
- ノートPC（RTX 4060 8GB）: 状況認識を qwen3-vl で担当する計画。手順 `docs/LAPTOP-OLLAMA.md`、疎通 `scripts/check-ollama.ps1`。`local` 経路の未修正点: num_ctx 未指定（8192 必要）、num_predict 1024 は短い、失敗時に Gemini へ戻らない、QA 判定は local でも Gemini を呼ぶ（`QA_ENABLED=false` で止める）。将来案: ノートが TD+カメラ+4画面、デスクトップが サーバー+ComfyUI、Tailscale で外からも。緊急用に `GENERATION_BACKEND=gemini`（画像も Gemini、1撮影 約21〜25円、1時間 約740〜840円）を整備予定。gemini 経路の未修正点: 画像モデル固定（`gemini-2.5-flash-image`、終了日が公式ページで矛盾）、QUALITY_SUFFIX/時計/Presence が渡らない、1枚失敗で撮影全体が失敗
- 料金の累計: 226.37円（85回、10-06 10:10 時点）。`Capturemode = manual`、間隔 105秒、距離 +30/+30/+150（ユーザー設定）
- テスト用の写真12枚: `C:\Users\nmrei\GitHub\speculative-memory_data\test_set\`。テスト出力は `tone_test\`、`dist_test\`
- **slider4 / slider5 は空きではない**（出力フェードの長さと明るさ）。触らない

- ComfyUI: 起動中。Node サーバー: 02:45ごろ再起動済み（ユーザー許可）。反映済みなのは「腕は2本」ルール、Gemini 自動品質検査、料金記録、無人の部屋対策 v2（新しい人・物を足さない、小物を動かさない、暗いモニターは暗いまま）
- **未反映（再起動待ち。ユーザーの許可が必要）**: 操作パラメータ（Future distance / Presence / Tone）、Future Cone 表示のサーバー側、状況説明の TD 表示のサーバー側
- **TD は未保存**（Scene ページ、slider1〜3 の配線、`ui_root/cone_viz`、料金表示 `cost_display` が .toe の中にある）。**ユーザーに Ctrl+S をお願いすること**
- **4枚（NOW / PAST / FUTURE A / FUTURE B）の状況説明の TD 表示は実装済み（10-06 朝）**。サーバー側（`sceneText`/`nowText`/`distanceSec` を capture.saved に載せる。定型の「変な映像防止」文は含めない）はコード済み・再起動待ち。TD 側は `ui_root/scene_text`（`touchdesigner/td_scene_text.py`、/perform の下の帯に4枠、長文はスクロールバー）が .toe の中にあり**未保存**。ダミー文では表示とスクロールを確認済み。本物の撮影での確認はまだ
- その次の確認（ユーザー許可を取ってから）: サーバー再起動 → 手動で1回撮影し、Cone 図に画像が順に入るか・状況説明が出るか・パラメータが効くかを見る（1回 約5円）
- 改良ループの cron は解除済み（撮影停止中のため）。再開時にユーザーと相談して作り直す
- **画面上部の Manual / Auto ボタンと「間隔（秒）」スライダーは本物の操作（10-06）**: 実際の `Capturemode` / `Captureinterval` と連動する。Auto は1回押すと確認メッセージだけ出し（10秒以内にもう一度押すと timer 開始）、timer/chain 中は赤字「自動撮影中」が出る。TD は未保存（`touchdesigner/td_mode_chooser.py`）
- **コミット**: ユーザーは「コミットはあした（10-06）する」と言った。未コミットの変更が大量にある（下の5章）。プッシュはユーザーが自分で行う（Git Credential Manager のログインが必要）

- **CPU 手検出（10-19）**: 公開前検査で VLM の手数判定に加え、MediaPipe HandLandmarker（`scripts/hand-count.py`、`server/handCount.ts`）が出力画像の手を数える。**検出数 > 2×想定人数（1人なら3以上）で `extra_hand` 却下**。VLM（3本以上）と OR。AI/LLM 呼び出しは増えない。VLM 呼び出しと並列に走る（子プロセス1回 約1秒、検出本体 約0.3-0.4秒）
- インストール先は顔ボックスと同じ CPU venv `C:\Users\nmrei\claude-code\runtime-face-detector`（Python 3.12、Comfy の venv ではない）: `runtime-face-detector\Scripts\python.exe -m pip install --no-deps mediapipe==1.1.1 absl-py flatbuffers certifi` と `... -m pip install matplotlib`。**`--no-deps` は必須**（素の `pip install mediapipe` は opencv-contrib-python 5.0 を入れ、顔検出の opencv-python-headless 4.11 と cv2 が衝突する）
- モデル: `C:\Users\nmrei\GitHub\speculative-memory_data\models\hand_landmarker.task`（Google 公式 float16、7.8MB、sha256 fbc2a300…、repo 外・コミットしない）。env で上書き: `HAND_LANDMARKER_MODEL` / `HAND_DETECTOR_PYTHON`（未設定なら `FACE_DETECTOR_PYTHON`）/ `HAND_CONFIDENCE`(0.25) / `HAND_WRIST_MASK`(0.3)。**閾値は暫定**（調整に使えた画像は回帰素材 6 枚のみ。0.15 では 14-05-26 が 4 本になった。誤検出・見逃しが出たら 6 枚＋新例で再調整すること）
- 検出は 原画＋左右反転 × 2パス（見つけた手を灰色で塗って再検出。手首に小円も塗り、時計や前腕を手と数えない）。隣接する手を palm 検出器が1つにまとめてしまう弱点への対策
- 検出器が無い/失敗のときは1回だけ警告ログを出して VLM のみで判定。`observationFacts.cpuHands` に status/count/limit/boxes/ms を記録（rejected の integrity.jsonl にも載る）
- 回帰: 陽性4枚（B_old / B_new / Gen_b_14-06-42 / Gen_b_14-05-26）は CPU 3本、陰性2枚（B_old_s1 / B_new_s1）は 2本。CPU だけ試すときは `tsx scripts\inspect-images.ts <gid> <A|B|C> <png...> --cpu-only`（VLM なし）。本番反映にはサーバー再起動が必要
- **髪色と後ろ姿（G-13/G-15、10-19 夕）**: 15:20-15:23 の後ろ姿4枚が全体ピンク髪（実物は黒髪で毛先だけピンク）・B の1枚が横顔だった。`server/generation/hairPhrase.ts` が髪を「地毛色＋毛先色」に分け、`behindViewSentence` は「black hair, only the tips pink (the rest of the hair stays black; never colour the whole hair pink)」と書く（地毛色不明の "pink-tipped" は「元の暗い地毛色、毛先だけ pink」）。negative に "fully pink hair…" と "face in profile, side view of the face" を追加。DESCRIBE_PROMPT は地毛色を先に書き、毛先色だけを書かないよう指示
- 後ろ姿文に `BEHIND_VIEW_NO_FACE_RULE`（"Seen from behind; no part of the face is visible: no profile …"）を追加。参照切り抜きは head_box があれば頭＋肩＋胴の全身（`figureCropFor`）、無ければ従来の位置三分割
- **物体ゲート（G-24）**: 人物を描くシーン（personDrawn=true）では planner の物体変化が「…, while the bin …」で残っていた（`vlmClient.ts` の recentDraw 合成と finishWith が非人物シーンにしかゲートを掛けていなかった）。今は objectAllowed=false なら `resolveRecentPersonScene` で人物の静かな動きだけになる。人物なしのシーンは従来どおりスキップ
- activityMinutesAgo が null だったのは 3分窓で別検索していたため。今は recentPerson と同じ出所（live: latestPerson / test: latestTestPerson）から `activityMinutesFromRecent` で分数を出す（06:22 は 5分 → no_recent_activity）
- 06:22 入力のオフライン再現（モデル呼び出しなし、emptyRoomDecision.test.ts）: operator_mention の3シーンは人物のみ（箱・蓋の変化なし）、言及なしならロール 0.64/0.68/0.75 で3シーンともスキップ。本番反映にはサーバー再起動が必要（未実施）

### 2026-10-19 追記: テスト直近人物の再起動耐性と chain の空回り防止（サーバー未再起動）
- 症状（再起動6 18:53 以降、L004）: 無人回が3シーンとも skip（no_recent_activity / emptyRoom no_recent_person、`[history] … recent person: none`）で、chain が完了直後に次を撮るため約14秒ごとに VLM を空回り。原因はテスト用の直近人物（ScopedTestHistory＋TestPersonFrames）がメモリのみで再起動で消えること（再起動5の後は F001–F003 が有人だったので出なかった）。operator_mention の不具合ではない（G-01）。
- 修正1（server/history/testRecentPersonStore.ts、TestRecentPersonStore）: テストスコープの有人フレーム（frameId・historyScope・replayedAt・people〈head_box/hair/clothes/position〉・元フレーム JPEG）を `speculative-memory_data\state	est-recent-person\<sha256(scope)先頭16桁>\<frameId>.json|.jpg` に保存（env TEST_RECENT_PERSON_DIR で変更可）。上限は従来通り 1スコープ4枚・12スコープ・replayedAt で10分。起動時に読み込み、期限切れは削除。書けないときはメモリのみ（ログ1回）。scene-history.jsonl（会場履歴）には触れない。
- 修正2: それでも見つからないテスト回は、アーカイブ（直近2日分のフォルダを新しい順）から同じ historyScope・10分以内・guard.detector.person=true の最新 prompts.json を探し、_NOW.jpg＋guard.people を直近人物として使う（`[history] recent person recovered from archive (N min ago)`、モデル呼び出しなし、見つけたものはストアにも保存）。
- 修正3（server/nativeOperator.ts、autoCaptureDue / zeroScenesGenerated）: 完了したキャプチャの生成シーン数が0（全シーン skip）のとき、chain は完了時刻から設定 intervalSec（既定70秒）待ってから次を撮る（`[chain] all scenes skipped; waiting 70s`）。シーンが1枚でもあれば従来通り約1秒後。timer は従来通り。
- テスト: testRecentPersonStore.test.ts（5件: 保存→新インスタンスで latestTestPerson、期限・上限での削除、ディレクトリ不可、アーカイブ復元フィクスチャ）、nativeOperator.test.ts に chain ペーシング1件。tsc クリーン、TS 全体 949 件中失敗は既知の2件のみ。反映には再起動が必要。

## 1. 何を作っているか

固定カメラの1フレームから「起こりうる3つの世界」（未来A・未来B＝N秒後、過去＝N秒前。N は Future distance、既定30秒）を生成して並べて見せるインスタレーション。

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

TD のキャプチャ設定（/project1 の Capture ページ）: **現在 manual（ユーザー指示で停止中）**。タイマー間隔は90秒設定。タイマーは「毎回必ず撮影して captures/ に保存、生成は空いているときだけ」。連続モード（3枚そろったら次）、手動（キー `1` / ボタン。生成中なら中断してやり直し）。`timer1` は1秒の「心拍」で、判断は `td_native_capture.py` がする。

## 4. 実測値と、そう決めた理由

- 1キャプチャ ≒ Gemini 11〜26秒 + 画像3枚 約42秒（1枚 12.3秒）。3時間で118回、失敗0。TD 同時起動でも RAM に余裕あり
- **GGUF Q4_K_M（12.3GB）+ smart memory ON** が最速。fp8（19.1GB）は CLIP と VRAM に同居できず毎回入れ替えが発生していた（53.3秒→38.1秒/3枚）。fp8 モデルは戻す用に残してある
- 効かなかったもの: `--fast`（fp8 は既定でネイティブ）、プロンプトのバッチ化、デコードのバッチ化、1280×720 で直接生成（0.5秒速いだけで時計の数字が崩れる）、ステップ削減
- 表示は実は **1280×720**（TD が Non-Commercial ライセンスで 1280px 上限）。カメラも C920 を 1280×720 で受ける。生成は 1392×752 のまま
- **ネガティブプロンプトは効いていない**（Lightning は cfg 1.0 必須で、cfg 1 では負側を計算しない）
- NAG は Qwen-Image では無効（コア `NAGuidance` は Qwen のモデルコードが対応する patch を呼ばない。外部ノードも非対応）
- Gemini の料金は Claude のクレジットとは無関係。**実測で1キャプチャ約4〜6円**（以前の「0.3〜0.5円」は誤りだった）

## 5. git の状態

- ブランチ `feat/capture-modes-gguf`（`feat/local-comfyui-qwen` から分岐）。最新コミット 626388a。**未プッシュ**（プッシュはユーザーが決める）
- **未コミットの変更（10-06 時点）**: `gemini-prompts.json`, `server.ts`, `server/generation/{comfyClient,orchestrator,vlmClient}.ts`, `services/{geminiService,promptBuilder}.ts`, `touchdesigner/{td_capture_listener,td_native_capture}.py`, 新規 `server/qa/`, `server/usage/`, `scripts/`（qa-summary.ts, ab-test.ts）, `services/sceneParams(.test).ts`, `touchdesigner/td_cone_viz.py`, このメモ。コミット前に `npx tsc --noEmit -p .` とテスト（30件）を確認
- タグ `pre-tuning-2026-10-03` = 今回の変更前の状態（戻し方: 設定だけなら .env.local の GGUF/LIGHTNING/HIRES 行を消す）
- `stash@{0}`（2026-09-05, GitHub Desktop 作成）に本番録画とキャプチャ約13GB が入っている。`C:\Users\nmrei\GitHub\speculative-memory_data\` に取り出し・検証済み。**ユーザーが外部にバックアップするまで stash を消さない**
- `.git` に緩いオブジェクトが13GBあり、コミット時に git の自動整理が走って固まることがある。そのときは `git -c maintenance.auto=false -c gc.auto=0 commit ...`
- 9月展示版（別PC版）は `speculative-memory_demo-sep`（worktree、ブランチ `demo-2026-09`）に未コミットで存在。コミット手順 `COMMIT-DEMO-SEP.md`。

## 6. 仕組みの追加分（10-05〜10-06）

- **料金記録**: `server/usage/costTracker.ts`。Gemini の呼び出しごとに実トークンと料金を `logs/usage.jsonl` に記録、`GET /api/usage`、UDP `usage.updated` で TD の `cost_display`（/perform 左下）と Capture ページ `Costtoday`/`Costtotal` に表示。実測: シナリオ 1回 約1.4〜2.4円、品質検査 1回 約1.6〜3.7円 → **1キャプチャ約4〜6円**（思考トークンが大半）。10-06 03時の累計 約179円（55回）。単価は gemini-3-flash-preview 入力 $0.50 / 出力 $3.00 per 1M、USD_JPY 157.73
- **Gemini 自動品質検査**: `server/qa/imageJudge.ts`。キャプチャごとに元写真＋3枚を判定し `logs/qa.jsonl`、重いものは `captures/qa_flagged/`。集計: `./node_modules/.bin/tsx scripts/qa-summary.ts [時間] [最小重大度]`。約1/3〜1/2 を sev≥2 で拾う（誤検出も多い）ので、Claude が画像を見て本物の失敗か確かめる
- **比較テスト**: `scripts/ab-test.ts <label> <outDir> <source.jpg...>`（環境変数 `AB_DISTANCE` / `AB_PRESENCE` / `AB_TONE`、`AB_NO_JUDGE=1` で判定省略）。本番サーバーとは別プロセスで、ディスク上の最新プロンプトを使う。出力は captures/ ではなく指定フォルダ。ここでの Gemini 料金は usage.jsonl に入る
- **操作パラメータ**（未反映）: Futuredistance 5〜300秒（既定30）、Presence 0〜1（0.3）、Tone 0〜1（0.3）。文の定義は `gemini-prompts.json` の `sceneControls`、処理は `services/sceneParams.ts`。TD は /project1 の Scene ページ、slider1〜3 が式で駆動（パラメータ画面からでなくスライダーで変える）。Presence 0.45 以上でだけ「人の追加」を許す（腕2本・重複禁止は常に有効）
- **Future Cone 表示**: `ui_root/cone_viz`（`touchdesigner/td_cone_viz.py`）。−N … NOW … +N、過去は左、未来A は右上、B は右下、開き角 = 15° + 45°×(0.5·Presence + 0.5·Tone)。生成中は枝が点滅し、届いた画像から埋まる。実キャプチャではまだ未検証（`simulate()` でのみ確認）

## 6.5 既知の問題（次の改良候補）

- Tone を 1 にしても Gemini が控えめな場面しか書かない（劇的にならない）
- 大きな動き（2分・Presence 1）で部屋全体が描き直され、カメラ固定が崩れる
- 過去の画像がシナリオと食い違うことがある（「手は膝の上」なのにキーボードの上）
- 顔が画角で切れていると別人の顔を想像で描く → カメラで頭まで入れる
- 無人の部屋で、画面の端から入る人の手がゆがむことがある
- 腕・人の重複がまだ残るなら `CFGOverride`（最初の1ステップだけ cfg 2、+約1.7秒/枚）
- ネガティブプロンプトは効かない（Lightning は cfg 1.0）。NAG は Qwen-Image 非対応

## 7. 未決・宿題

- **シャッフル**: Stream Deck のシャッフル（`s`/`h`/`o`/`r`）は `ensyutu_part1.toe` にだけある（`shuffle_exec`: window1〜4 に switch0〜3 をランダム割り当て）。part2 に移植するか未決。part2 の window1 は `fb_composite1`（未来A＋残像）を映している点に注意。part1 は8/28の固定画像を見せる独立ファイルで、生成とはつながっていない
- TD の `ui_root` の FUTURE DISTANCE / PRESENCE / TONE（slider1〜3）と FUTURE CONE VISUALIZATION は 2026-10-06 に配線済み（改良ログ参照）。他の見出し（FRAME SELECION, CUSTOM PROMPT, GENERATE）は見出しだけ（画面最上部の Manual / Auto と間隔スライダーは飾りではなく Capturemode / Captureinterval につながっている）
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
- TD の変更、プッシュ、データ削除、撮影の開始は確認してから（サーバー再起動は 10-15 以降は確認不要）
- 0章のルールを必ず守る

## 9. ハマりどころ

- ComfyUI Desktop の API はポート **8000**（8188 ではない）
- PowerShell 5.1 / cp932 で Python の出力が文字化け・例外 → `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`
- `Start-Process` の引数でパスに空白（`Comfy Desktop`）があるとクォートが必要
- ComfyUI は展示と共有。テストで `/interrupt` を全体に送らない、キューを消さない（個別キャンセルは `POST /api/jobs/{id}/cancel`）
- Ollama のモデルは ComfyUI が VRAM を使っている最中に読み込むと CPU にはみ出して遅い。`deepseek-r1:32b` はコンテキスト 8K で全部 GPU に載る

## 改良ログ

- 2026-10-06 夜: 画面最上部の Manual / Auto ボタン（`/project1/modeChooser`）を本物の `Capturemode` につないだ。ロジックは `touchdesigner/td_mode_chooser.py`（TD の `/project1/td_mode_chooser` とファイル同期）。Manual は即 manual に。Auto は**1回目は確認だけ**（「タイマー撮影を開始します（90秒ごと・1時間 約200円）。もう一度 Auto を押すと開始」を表示）、10秒以内の2回目で `td_capture_panel_controls.request_capture_mode('timer')`、10秒たつと確認は消えて Manual 表示のまま。表示は実際の Capturemode に追従（manual→Manual、timer/chain→Auto。確認中は Auto を光らせない。パラメータページやスクリプトでの変更にも追従、0.25秒ごとに照合）。timer/chain 中は赤字「自動撮影中（timer・90秒）」。間隔スライダー（30〜600秒、5秒刻み、数字表示）は `Captureinterval` と双方向。間隔の変更では何も始まらず、実行中は `td_native_capture.heartbeat()` が毎秒読むのでそのまま反映。新規: `/project1/td_mode_chooser`、`td_mode_chooser_exec`（起動時にループ開始）、`mode_extras`（lbl/slider/val/msg/slider_pexec）。modeChooser の変更は `Runofftoon` を on_press に、`hmode` を fill→fixed（幅400）にしただけ。テストは DRY_RUN（本物の timer には一度もしていない）。TD 未保存。

- 2026-10-06 夜: 空の暗い部屋で「新しい人・袋・モニターが増える」対策として、gemini-prompts.json の hardRules（±30秒は短い／人がいなければ新しい人を真ん中に出さない／物を増やさない・小物は動かさず椅子の回転やモニター消灯など「その場の変化」を優先／動かすなら FROM→TO と元の場所は空）、vlmClient.ts の JSON_INSTRUCTION、comfyClient.ts の QUALITY_SUFFIX（新しい物・人を足さない、動いた物は元の位置から消す）を追加。A/B（1回ずつ・n小）: 空の部屋 3元画像×3枚で flagged 前 1/9 → v1(「動かすならFROM→TO」だけ) 6/9（袋の複製が増えて悪化）→ v2(小物は動かさない) 2/9。人物写真 2元画像×3枚は 前 5/6（顔の別人化が中心）→ 後 1/6。サーバー未再起動（反映は報告待ち）。
- 2026-10-06 深夜: 操作パラメータ3つを実装。Futuredistance（5〜300秒, 既定30。未来A/B=+N秒・過去=−N秒。Gemini プロンプトの「30 seconds」・時計の数字・scenarioDirection（秒/分）に反映）/ Presence（0〜1, 既定0.3。人の出現・動きの文を範囲で選択）/ Tone（0〜1, 既定0.3。落ち着き〜劇的だが物理的に自然）。サーバーは `/api/generate` の `futureDistanceSec`/`presence`/`tone` を clamp＋既定値で受け、capture ごとにログ（prediction_data.md にも）。TD は /project1 の Scene ページ（Futuredistance/Presence/Tone）を slider1〜3（ui_root の見出し下、距離は対数 5〜300秒）で駆動し、`td_native_capture.py` が送信。FUTURE CONE VISUALIZATION は `ui_root/cone_viz`（`touchdesigner/td_cone_viz.py`）。文の定義は gemini-prompts.json の sceneControls。サーバー未再起動（反映は再起動後）。

- 2026-10-06 朝: 4枚の状況説明を TD に表示。サーバー: `services/promptBuilder.ts` の `scenarioContentText`（シナリオ説明だけ）/`nowContentText`（状況認識の結果そのまま）、`server.ts` が capture.saved に `sceneText`/`nowText`/`distanceSec` を付けて UDP 送信、prediction_data.md にも now を記録（`services/sceneText.test.ts` あり）。TD: `ui_root/scene_text`（コンテナ。中に p_now/p_past/p_a/p_b、各枠にラベル `lb` と本文 `tx`＝Text COMP の type=multiline、スクロールバー常時表示・ホイール可）。`td_capture_listener.py` の `onReceive` が `td_scene_text.on_capture_payload()` を呼び、画像が届いた時点で更新（新しい captureId で4枠をクリア）。コストの表示 `cost_display` は幅 640→268 に縮めて重なりを回避（ファイルと TD の両方）。位置は ui_root の x280, y40, 幅996, 高さ90。ハマり: Text COMP は type が string だと改行を無視する、日本語は multiline にすれば自動で折り返す。確認は `td_scene_text.simulate(long=True)` と opviewerTOP のスクリーンショット。tsc とテスト33件は通過。サーバー未再起動・TD 未保存。
- 2026-10-06 朝: Tone が効かない問題を直した。原因は、Gemini に渡す文で Tone が1行だけで、「30秒は短い・小さな変化を優先・人は少しだけ動く」に打ち消されていたこと（Tone 0 と 1 で差は1行、結果もほぼ同じ）。`gemini-prompts.json` の `sceneControls.tone` を4段階（0.15未満＝ほぼ何も起きない／0.45未満＝小さな日常動作／0.75未満＝はっきりした動作と表情／それ以上＝驚く・急に立つ・大笑いなど一目で分かる瞬間）に書き直し、過去を含む全シナリオに適用、最高段階は「小さな変化を優先」より優先と明記。`hardRules` に「フレームの中に見えているものだけを使う」を追加。確認（人物写真2枚、Gemini 16回・23.54円）: 文も画像も段階がはっきり出た。ただし Tone 1 では、頭が画角で切れた写真で顔が別人になる例、白いノートPC や鉢が増える例が出た。無人の部屋の画像、Presence・距離との組み合わせは未確認。`scripts/ab-test.ts` に `AB_NO_IMAGES=1`（文だけ生成）を追加。サーバー未再起動。
- 2026-10-06 朝: 時間距離を3枚それぞれに設定できるようにした（−10分〜+10分。負が過去、正が未来。|d| は5秒以上）。**TD 側**: /project1 Scene ページに `Distancea` / `Distanceb` / `Distancec`（既定 +30 / +30 / −30）。操作パネルは TEMPORAL DISTANCE A / B / C（A は slider1、B・C は `slider_dist_b` / `slider_dist_c`）と PRESENCE・TONE の5行。スライダーは中央が符号の境目の対数目盛り（`touchdesigner/td_scene_distance.py`）。`Futuredistance` は残すが使わない。TD は `sceneDistancesSec: [a, b, c]` と旧サーバー用の `futureDistanceSec = abs(a)` を送る。Cone 図は NOW 中央・過去は左・未来は右・距離が大きいほど外側で、サムネイルとラベルは「その画像を作ったときの距離」、いまのスライダー値は下の目盛りに白抜きの丸で出す。以前の Presence/Tone による開き角は廃止。状況説明の枠のタイトルは「A  FUTURE +30 s」の形。**サーバー側**: `sceneDistancesSec` が無い・不正なら従来の N から `[+N, +N, −N]`。`capture.saved` の `distanceSec` は符号つきで `distanceSigned: true` を付ける。Gemini への指示は「Scenario 2: 約2分 BEFORE」のようにシナリオごとに向きと長さを指定し、長さの文は10分まで対応。時計の数字も各画像の距離でずらす。2分以上の画像には「背景とカメラは元写真と同じ」を追加。テストは `AB_DISTANCES="a,b,c"`。確認（Gemini 7回・11.50円、tsc とテスト48件は通過）: 文は向きと長さに従う。画像は ±30秒なら部屋もカメラも同じ。2分・10分で人が席を離れると、袋が消える・ノートPC の画面が点く・机の下が描き足されるなど背景が変わる（未解決）。過去側は Tone が低いと10分前でも変化が小さい。実サーバーでの通し確認、時計の数字、Ollama 経路は未確認。サーバー未再起動、TD 未保存。

- 2026-10-07: TD と Node サーバーを別のPCに分けられるようにした（既定は今まで通り1台）。サーバー: `/api/generate` の本文に `notifyToSender: true`（リクエストの送信元アドレスへ UDP を返す）または `notifyHost`（IP/ホスト名を直接指定、こちらが優先）があると、その撮影の UDP 通知（generation.* / capture.saved）をそのPCへ送る（`server/network/notifyTarget.ts`、テストあり）。`TOUCHDESIGNER_UDP_HOST/PORT` は既定の送り先として残す。新しい環境変数 `PUBLIC_BASE_URL`（既定 `http://127.0.0.1:3000`）で、`url` / `latestImageUrl` / `sourceImageUrl` を絶対URLにし、`nowUrl`（元写真）を追加（絶対パスのフィールドは従来通り）。`captures/latest*.json` と `prediction_data.md` は `Cache-Control: no-store`。`CAPTURES_DIR` は検証用の別インスタンス向け。TD: /project1 の Network ページ（`Serverurl`、`Imagesource` file|url、`Notifyhost`）を `td_native_capture.install_network_parameters()` で作る。`Imagesource`=url のとき `td_capture_listener.py` が Movie File In を `Serverurl`+`/captures/…` の URL に向ける。Serverurl がループバックでないときだけ td_native_capture が notifyToSender（または Notifyhost）を送る。手順は `docs/TWO-MACHINE-SETUP.md`。サーバー側は検証済み（別ポート 3101、課金なし。tsc とテスト53件は通過）。サーバーの再起動と TD の DAT 同期は未実施。実機（2台）は未確認。

- 2026-10-06 朝〜10-07: Cone 図をスライダー（Distancea/b/c）に即時追従するよう変更（撮影時の距離が違うときだけ小さく「撮影時 −30 s」、下部は −10 m…NOW…+10 m の時間軸。`td_scene_distance.py` の変更コールバックから `cone_viz` の `refresh()` を呼ぶ、約1フレーム）。左上の FRAME SELECTION を非表示にして C920 のライブ映像（LIVE CAMERA）を出したが、.toe の保存（10-06 10:08）に間に合わず消えた（要再作成）。距離 +30/+30/+150 の実撮影テスト（6.18円）で、サーバー→TD の距離・状況説明・Cone・料金表示は一貫して動作。C=+2分30秒の「席を立つ」は画像に反映されず（画像指示の矛盾が原因候補）。
