# ルールブックと継続 QA

画像生成エンジンに渡すプロンプトの「固定の決まりごと」を 1 つのファイル（版つき）にまとめ、ローカル Qwen で毎回の生成画像を検査し、不良の集計から自動で改善し続ける仕組み。
TD に出る表示文（短い日本語）と、エンジンに渡す詳細なプロンプトは分けたまま。全文は各撮影の `_prompts.json`（アーカイブ）と `/logs` で見られる。

ユーザー判断（原文）: 「画像がおかしいかおかしくないかの判断は、並行してずっと QWEN で走らせて。で、プロンプト生成する際のルールを、改善し続けて。いきあたりばったりでそのときそのときだけ修正するんじゃなくて。」「自動で反映し続けて。こまったら聞いて。」

## 1. 構成

| 場所 | 役割 |
|---|---|
| `rulebook/rulebook.v<N>.json` | 版ごとのルール全文（画像・人物情報なし。公開リポジトリに置いてよい）。v1 = 既存の文言をそのまま移したもの |
| `rulebook/active.json` | 現在有効な版（`version`、`appliedAt`、`by`、`reason`）。**これを書き換えるだけで切り替わる。再起動は不要**（撮影ごとに読み直す） |
| `rulebook/CHANGELOG.md` | 版の変更履歴（自動適用・ロールバック・ユーザー承認） |
| `rulebook/USER_GUIDELINES.md` | ユーザーの判断（G-xx）。**自動改善は変更・削除しない** |
| `server/generation/ruleTexts.ts` | v1 の文言そのもの（リーフモジュール） |
| `server/generation/rulebook.ts` | 読み込み・検証・版の切替と、プロンプトの部品（`negativePrompt()`、`qualitySuffix()`、`physicsBlock()`、`withVlmExtras()` など） |
| `server/qa/localJudge.ts` | ローカル Qwen の検査、キュー、集計 |
| `server/qa/improver.ts` | 自動改善（適用・ロールバック・人に聞く） |
| `server/qa/qaService.ts` | サーバーへの組み込み（キュー、ログ、API） |

ルールブック v1 の内容（`rulebook.v1.json`）:
- `imagePrompt`: 物理ルール（G-07）、髪（G-13）、後ろ姿・1 人だけ・位置と縮尺（G-02/G-12）、手前物体の実寸（G-06）、体の一部を生やさない（G-04）、参照人物、無人時の文、**無人テンプレート**（`emptyRoom.head/scope/keep/preserve/noAdd/screens/tail`。人物語ゼロ）、`extraConstraints`（自動改善が足す文。v1 は空）
- `quality`: 品質文（通常 / 人物が入ってよいとき / 時計 / 長い時間差）
- `negative`: 負のプロンプト（基本 / 時計 / 無人時の人物語 / 後ろ姿用）と `added`（自動改善が足す語。v1 は空）
- `guard`: 再試行回数（既定 3、環境変数 `VLM_GUARD_RETRIES` が優先）、時間予算（25000ms、`VLM_TIME_BUDGET_MS` が優先）、重複しきい値 0.9、`extraObjectGroups`（物の捏造ガードの追加語彙）、`extraEmptyRoomBannedWords`
- `vlm`: `extraInstructions`（計画の指示に足す 1 文ずつ。v1 は空）

**自動で変えてよい項目**（`EDITABLE_PATHS`）は「追加だけ」: 負のプロンプトへの語、固定制約への 1 文、ガード語彙、計画への 1 文、再試行回数（0〜5）、時間予算（10〜40 秒）。それ以外（G-xx の文言、無人テンプレート、品質文）は固定。

## 2. 継続 QA（ローカル、無料）

- 撮影の 3 枚が完成した後、撮影と撮影の合間に 1 枚ずつ検査する（`QaQueue`: 直列、撮影中は走らない、新しい `/api/generate` が来たら実行中の呼び出しを中断して後回し、待ちが 12 件を超えたら古いものを捨てる）。test:true の撮影・スマホ側の撮影は検査しない。
- 撮影が TD のタイマーで等間隔に来ているとき（直近 4 回の開始間隔が ±30% 以内）は、次の撮影の予想時刻の 12 秒前までに終わる見込みのときだけ 1 枚の検査を始める（撮影の最初の検出呼び出しが、検査の呼び出しの後始末に待たされないため）。予想できないとき・予想より 30 秒以上遅れているときは「撮影中でない」だけを条件にする。`GET /api/qa` の `idleWindow` / `nextCaptureEstimate` で見え、`scripts/qa-backfill.ts`・`scripts/qa-judge.ts` もこれに従う。
- 検査は qwen3-vl:4b-instruct に画像 2 枚（元フレームと生成画像）を渡す 3 回の短い呼び出し: (A) 生成画像に増えた物・消えた物、(B) 画像を入れ替えて同じ質問（独立した証拠）、(C) 生成画像 1 枚だけで「浮いている・体の破綻・巨大化」。**4B は「欠陥はあるか」と直接聞くと毎回「問題なし」と答える**ため、差分の列挙を取り、指示文（prediction_prompt）が求めた変化を除いてサーバー側で分類する。
- 結果 `{ok, score, defects:[{type, where, note}]}`。type は固定: fabricated_object / fabricated_person / missing_object / floating / implausible_placement / anatomy / scale / screen_changed / mismatch / other。失敗は `ok:null`（不明。不良率の分母に入れない）。
- 保存: `logs/qa-local.jsonl`、アーカイブ `_prompts.json` の各シーンの `qaLocal`、`logs/capture-events.jsonl` の `qa` 要約。各撮影・各シーンに `rulebookVersion`（`prompts.json`、capture-events、`capture.saved` の payload）。
- API: `GET /api/qa?limit=100`、`GET /api/qa/summary?day=YYYY-MM-DD&by=rulebookVersion|day`、`GET /api/qa/proposals`、`GET /api/rulebook`（有効な版・版一覧・却下・変更履歴）。`/logs` の上段に版ごとの不良率と変更履歴を表示。
- 既知の限界: 4B は見落としが多い（浮いたノート PC・新しく足された椅子は見つけられないことがある）。不良率は「絶対値」ではなく、版の間の比較に使う。
- 過去の画像で基準を作る: `npx tsx scripts/qa-backfill.ts --day 2026-10-16 --captures 30`（撮影中は止まる。version 1 の行として入る）。単体確認: `npx tsx scripts/qa-judge.ts <生成ID> A,B,C`。

## 3. 自動改善（`server/qa/improver.ts`）

撮影 `QA_IMPROVE_EVERY`（既定 30）件ごと（現在の版の判定済み撮影）に、合間のキューで 1 回実行する。`QA_AUTO_IMPROVE=false` で止まる。

1. **検証**: 直前に自動適用した版を、その親の版（直前 N 撮影）と比べる。不良のある画像の割合、または対象にした不良種別の率が **`QA_ROLLBACK_DELTA`（既定 +0.05 = 5 ポイント）以上悪化**したら、自動で親の版に戻し（`active.json` を書き換え）、その版を「却下」として `logs/rulebook-state.json` に記録する。同じ変更は二度と提案しない。
2. **提案**: 不良率が 3% 未満なら何もしない。そうでなければ上位 1〜2 種別（各 3 件以上）について、小さな追加を作る。まずローカル Qwen のテキスト呼び出し（`QA_IMPROVE_LLM=false` で無効）に「その不良を避ける短い 1 文」を作らせ、JSON スキーマと検証（制約文 `imagePrompt.extraConstraints` と計画への 1 文 `vlm.extraInstructions` だけ、無人テンプレートに人物語を入れない、重複・却下済みを除く）を通らなければ、種別ごとの定型の候補（カタログ）を順に試す。**LLM には QA の生の注記を渡さず、負のプロンプトの語は LLM に作らせない**（試験で「laptops, white mug」のような実在の物の名前が出て、その物自体を消す規則になりかけたため。4B の注記は部屋にある物の名前を含む）。負のプロンプトの語はカタログ（無難な一般語）からだけ。
3. **適用**: 変更は最大 2 項目。`rulebook.v<N+1>.json` を書き、`active.json` を切り替え、`rulebook/CHANGELOG.md` と `logs/rulebook-changes.jsonl`（`{time, kind, from, to, changes, reason, defectStats}`）に残す。次の N 撮影が検証になる。

**人に聞く条件（自動適用しない）**: `logs/qa-proposals/<時刻>.md` に提案を書く（`[improver] needs the user` をログ、`GET /api/qa/proposals` で見える。UDP は送らない）。種別ごとに未処理の提案は 1 件だけ。
- 提案が表現に関わる: 変化の大きさ、人物を出すかどうか、トーン、Presence・距離、無人時の変化の種類にあたる語（`EXPRESSION_RE`）を含む。または種別が `fabricated_person` / `mismatch`（対処が表現の判断になる）
- 同じ不良種別が 3 版続けて改善しない
- 提案が少数の項目に収まらない（3 項目以上）、自動で作れる変更が尽きた（カタログ切れ）

## 4. 手で操作する

```
npx tsx scripts/qa-improve.ts --status                    # 有効な版、版一覧、直近の変更、未処理の提案
npx tsx scripts/qa-improve.ts --dry-run [--no-llm]        # 次の自動提案を見る（何も書かない。N 件の条件を無視）
npx tsx scripts/qa-improve.ts --apply                     # 今すぐ 1 サイクル
npx tsx scripts/qa-improve.ts --rollback [N]              # 版 N（省略=親）に戻し、今の版を却下
npx tsx scripts/qa-improve.ts --apply-proposal <ファイル>  # ユーザーが了承した提案だけ適用
```

**手で戻す最短手順**: `rulebook/active.json` の `version` を戻したい版の番号にする（例 `1`）。次の撮影から反映（再起動不要）。理由づけを残すなら `--rollback 1`。
環境変数: `QA_LOCAL_ENABLED`（既定 true）、`QA_LOCAL_MODEL`（既定 `VLM_MODEL`）、`QA_AUTO_IMPROVE`、`QA_IMPROVE_EVERY`、`QA_ROLLBACK_DELTA`、`QA_MIN_TYPE_COUNT`（3）、`QA_QUIET_RATE`（0.03）、`QA_IMPROVE_LLM`、`RULEBOOK_DIR`（テスト用）。

## 5. ルールを足すとき

- ユーザーの新しい判断は `rulebook/USER_GUIDELINES.md` に G-xx として追記し、エンジン用の文を **`ruleTexts.ts` と新しい版（`rulebook.v<N>.json`）の両方**に反映する（版を上げて `active.json` を切り替え、CHANGELOG に書く）。
- `orchestrator.ts` の `REFERENCE_FRAMES_SENTENCE`（参照フレームの文）はまだルールブックに入っていない（別セッションの実装中のため）。次の版で移す。

## 6. 追加の分類と /logs のガイドライン一覧
- QA の分類に `hair_mismatch`、`arms_raised`、`grid` を追加（`hair_mismatch` / `arms_raised` は予約名。4B はまだ確実に検出できない）。`grid` は機械判定（`server/qa/gridDetect.ts`）: 肌色の 32px タイルを Hann 窓 FFT し、高域（≥0.375 cycle/px）/ 中域（0.1〜0.25）の log10 の中央値が全体で −0.1 超、顔矩形に限れば −0.6 超なら疑い（肌タイル 3 個未満は判定しない。`QA_GRID_THRESHOLD` で全体の閾値を上書き）。実測: 10-16 の鮮鋭化あり画像は −1.4〜+0.2、修正後（19 時台）は −1.3〜−2.7。14-21-09 A（報告された格子）は −0.73 で、仕様の閾値では検出できない（顔矩形の指定が必要）。
- `/logs` に「プロンプト生成のガイドライン」表（`GET /api/guidelines`、`rulebook/USER_GUIDELINES.md` を読み取り専用で解析: G-xx / R-xx / 候補 C-xx と追加履歴）を表示。

## 7. G-14 / G-15（ユーザー承認、2026-10-16）
- 候補 C-01・C-02 を固定ルール G-14（持ち物を維持）・G-15（見えていない顔を新しく描かない）に昇格（`rulebook/USER_GUIDELINES.md`）。規則文は `imagePrompt.holdingsRule` / `noNewFaceRule`（有人テンプレートの髪の文の直後。無人テンプレートには入らない）。v3 = v2 + この 2 文 + 負のプロンプト 2 件 + 計画への 1 文。`scripts/rulebook-add-g14-g15.ts` で作成・切替済み。自動改善の検証・ロールバック対象外。
- QA 分類に `lost_belongings`（持っていた物の消失。マイク・スマホ・カップ等）と `new_face` を追加。`lost_belongings` は差分検査の「消えた物」から判定、`new_face` は名前だけの予約（4B は未検出）。
- テストは `NODE_TEST_CONTEXT` のとき実ファイルを読まず組み込みの v1 を使う（自動改善で有効版が変わってもテストが壊れない）。
