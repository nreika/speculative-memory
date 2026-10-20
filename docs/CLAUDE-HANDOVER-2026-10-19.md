最新状態：04:19 JST確認。テスト参照6配列すべて空、chain/hold falseで元の自動生成へ復帰済み。以下のhold trueや受入待ち記述は時点別記録で、末尾の実受入・失敗結果を優先してください。

# Claudeへの引き継ぎ（2026-10-19・更新中）

ユーザーは引き継ぎ資料の作成を依頼した後、「今やってる作業はそのままやって」と指示した。作業を続けながら本書を更新する。04:09 JSTの配備状況へ更新。**現在は人物参照の実受入のためholdtrue。試験後に元のchain運転へ復帰する。**

## 作業場所・基本方針

- 本体：`C:\Users\nmrei\GitHub\speculative-memory_0905`。スレッド初期cwdの`claude-code`は本体ではない。
- 写真・生成物・私有データ：`C:\Users\nmrei\GitHub\speculative-memory_data`。
- 調査・候補・検証記録：`C:\Users\nmrei\claude-code\tsc001-fix`。一部候補は同親の`claude-code`直下。
- AGENTS.md、rulebook/USER_GUIDELINES.mdを読む。古い引き継ぎより稼働コード・最新ログを優先する。
- 日本語で簡潔に報告。ユーザーに端末間のコピペ橋渡しをさせない。ノート担当と直接連絡・Taildropで受け渡す。
- 削除・コミット・プッシュはしていない。公開リポジトリに写真、キー、私有接続情報を追加しない。
- 既存自動運転を無断停止しない。新しいライブカメラ・TD・外部出力は開始しない。

## 稼働中の状態

- Node `:3000`：PID **36504**。04:08:34に追加人物参照を含め再起動。HTTP復旧04:08:39、停止5秒。
- ComfyUI Turbo `:8001`：PID **22956**。`qwen21-turbo`、8step、CFG1。2511へのfallbackはない。
- 最後の再起動にはシナリオ出力mapping、顔検出margin-v2、追加人物参照backend/v39b UI、load旧run表示修正まで含まれる。
- 元稼働は`chain`、`submissionHold=false`、3枚、`displayTiming=each`。現在は受入用`holdtrue`/idle。
- 入力はノートのテスト再生TSC-001、run `ba722eefda6642aca2846c45f1449a0c`、cycle=false。04:00頃F003/L004。
- **TSC-001でも後半は2人映る。1人＋追加1人の試験にはF001を明示的に選ぶ。**
- Scenarioは`SCN-001.csv`へ復帰済み。TDは停止したまま。ノートは入力供給・Ollamaを担当する。
- ノートの接続先・トークンは既存環境設定から取得する。Ollamaは`qwen3-vl:4b-instruct`、`think:false`、keep-alive 5mを維持。

## 実装・実画面確認まで完了したもの

### 画像割り当て、フェード、字幕

- MappingのAssign selected imageは即時保存・反映。他の未保存draftを巻き込まない。競合・通信不明時に成功を装わない。
- 出力ごとのoriginal（TD黒）／crossfade／none、片道時間`fadeDurationMs`、黒保持`blackHoldMs`。既定800/120ms、整数0..10000。
- 固定画像の切り替えでもTD黒フェード。生成追従は従来どおり完成batch一度、Each逐次公開を維持。同じ画像のpollでは反復しない。
- 実GUIで1.2秒・黒0.3秒、opacity79samplesを確認。試験後800/120へ復帰。
- 字幕消失は画像z-indexが字幕を覆っていたため、visual/captionのstackingを修正。実画面で10秒以上保持。
- 記録：`tsc001-fix\fade-timing-backend-20261019\root-verification.json`。

### 顔ぼかし・プリセット

- `view.faceBlur={enabled,strengthPx}`、強さ0..40。出力ごとと固定8チャンネルに保存。
- 表示だけCanvasで顔領域をぼかす。保存画像を変更しない。`content.faceRegions`は正規化XYWH、`faceRegionStatus`で検出失敗と顔なしを区別。
- CPU専用venv：`C:\Users\nmrei\claude-code\runtime-face-detector\Scripts\python.exe`。opencv-python-headless **4.11.0.86**。Comfy既存環境は変更していない。
- 顔検出はSHA cache、同時2、失敗短期cache。OFF時は検出しない。初回実測約1.17秒、同じ画像のcache約1.03ms。生成時間の改善とは別。
- `scripts/browser-face-boxes.py`はfrontal/profile margin-v2。3画像の背景誤検出を除去、小顔・横顔を保持。**遠方顔の未検出は残る。匿名化保証ではない。**
- 同一`record_2026-10-19_03-26-41.jpg`を再検出し正顔1・椅子box消失・原画SHA不変をrootで確認。修正後の旧cacheは03:43再起動で消去。
- 実GUIで生成画像12/20px、OFF復帰、SOURCE表示、プリセットJSON保存→読込→Applyを確認。全試験blur設定はOFF/12へ復帰。
- 素材asset2枚のbefore/after SHA同一。記録：`tsc001-fix\browser-face-boxes-20261019`、`face-false-positive-20261019`。
- Save/Load presetは画像ID参照を含むJSON。画像本体は含めない。読込はdraft、Applyで保存。

### シナリオから名前付き出力を操作

- CSVの必須4列を維持。新actions：`output_source`、`output_image`、`output_visible`、`output_labels`、`output_subtitles`、`output_fade`、`output_fade_sec`、`output_black_sec`、`output_face_blur`、`output_blur_px`、`output_delay_sec`、`output_scene`。targetは既存`screen-N`。
- Previewは保存configを変えずsnapshotの一時overrideを使用。`scenarioOverride={runId,source}`。Stopで解除。旧4slot Preview表示とStop復帰も維持。
- Liveは同BrowserOutputsStoreで保存し、Stopで開始時mappingへ復帰。手動変更とのrevision衝突では勝手に古い設定を復元しない。
- `scripts/operator-scenario/examples/SCN-MAPPING-001.csv`は20秒・4秒間隔・**生成命令0**。
- 実GUI Preview／Live両方でA→B→非表示→再表示→blur、Stop復帰を確認。Live85samples、requestedGenerations=0。rootでも全outputsとrevisionが開始時と完全一致を確認。
- 元chain／SCN-001／各出力へ復帰済み。記録：`C:\Users\nmrei\claude-code\scenario-output-mapping-20261019\root-deployment.json`。
- `operatorScenario.load()`で前runのgenerationCues/runId/errorを消去する表示バグ修正も04:08再起動で反映。8tests・型検査PASS。旧版ready表示に残るskipped行を新CSVの生成命令と誤認しないこと。

### TIME HISTORY

- v38を静的配備し実画面確認。既定Shared timeline↓、時間が上→下。同時刻は同高さ。従来Shared→とBy generationを残す。
- 39plots、280nodes=280unique、177接続線。旧横表示・生成単位103rowsも確認。時刻基準、ページ送り、SOURCE接続を維持。
- `tsc001-fix\history-v38-review\browser-acceptance.json`。
- **v40bは04:08に静的適用済み・実画面受入待ち**。SOURCE→Bの線がAカードを通り「BがAにつながる」ように見える問題の修正候補。
- v40は通常時差を改善したが0秒でA矩形を横切るケースを独立reviewで発見。v40b（同時刻は直交gutter、上端clip対処）を配備後、実DOMでcrossfoldの同じ列を通るB線1件がAを横切ることを発見。v40cは実A矩形を避ける修正候補でreview中。
- 現候補：Downloadsの`browser-v40c-source-branches.zip`。ノート担当が実SVG/スクリーンショット受入を行う。

## 次の配備・実受入：追加人物の参照

**backendとv39b UIは04:08:39に起動中Nodeへ反映した。実生成による成功は未確認。**

- 独立stage：`tsc001-fix\scene-person-reference-integration-20261019`。
- 25filesを`apply-minimal.py`で既存差分を保持して適用。バックアップは同stage/application-backup。
- rootで関連**185/185 tests PASS、全repo tsc PASS**。fade/faceblur/scenario配線を維持。
- UI：`control.mjs/css`の6欄。`scenes.a/b/c.continuousPersonReferenceIds`、`oneShotPersonReferenceIds`。
- v39bはmetadata一時503を永久missingとしない修正入り。2tests・syntax PASS。正常missingIdsだけplaceholder、失敗時5秒後再取得。
- 各fieldはUUID最大15、scene unionも15。実ComfyはSOURCE＋元顔画像＋追加画像の合計16枠。切り捨てない。画像枚数と人物数を混同しない。
- 元顔・髪refを保持し、追加refは別role。元人物の観察・NOW/historyは元のまま。sceneローカルallowedInventoryで元人物と追加人物を一回ずつ要求。
- 同一元人物のportrait2枚を別人へ誤対応する問題、人工refs7上限、合計8人上限はreview後に修正済み。
- 同じSHA/異なるIDは別人の証明にならない。識別不能・同一人物疑いはunknown。生体同一性を保証しない。
- 新規refは初回だけ観察cacheを作り、元顔crop／追加全画像をdense順で768高へ。既存1回の検査をcast対応へ置換。QAの一般欠陥検査は維持。
- 保存JSONへbase64参照画像を混入させない。private asset registryを参照する。
- **直近追加修正のテスト待ち**：極端な横長参照でscale幅が125832pxになる例を発見。実ImageScale最大16384をHTTPで確認し、`referenceScaleSize()`と受理前寸法検証を追加した。通常768処理は変えず、実ノード上限超過だけ明示reject。余白付き縮小への自動対応・より厳密な総pixel/VRAM予算は未対応。
- 同時に、追加人物castがある空室でnegativeへ「人物なし」を入れない修正を追加。Turbo CFG1ではnegativeは実質無効だが、矛盾するtraceを除いた。
- 最新寸法上限の関連44tests・全tsc PASS。04:08の再起動で反映済み。
- 次手順：ノートGUI Pause→idle→safe-restart→UI upload/preview/remove/Apply/reload→SOURCE1人F001＋別人portrait1人の限定実生成→OneShot一回消費／Continuous保持／scene間非混入→元設定へ戻す。
- ノートへTaildrop済み私有試験素材：`speculative-memory_data\experiments\reference-person-TSC005-profile.png`。既存TSC005の短髪人物だけの顔crop。元全景は2人なので使わない。cropは身体・服装が十分写らず、最初の顔同一性試験に限る。

## 未解決の品質・継続監査

- **3手不良を保存画像で確認**：`test-TSC-001-F007-L003-1792348882852`のB、`...1792348800262`のB/C。元の背中側2手を残して前方へ新しい手を追加している。
- 人数の検査成功を解剖の成功と扱わない。rootでも`0-B-all-hands.png`を実見した。
- 生成native／元画角復元／保存画像のRGBが一致し、元背景貼戻し合成は無効。今回の3手はモデル生成時点の不良。
- 監査：`tsc001-fix\auto-batch-quality-audit-20261019\quality-findings.v1.json`、selected-evidence.json、画像/crops。
- TSC002 F008 Aを「人物欠落」とした速報は誤り。原寸cropで右奥の頭と耳が残ることを確認し訂正済み。欠落fixtureに使わない。
- 真正欠落：`test-TSC-002-F007-L005-1792343956326`失敗A。右部分頭→棚への置換。既存検査が正しくrejectし、未配信。
- 次案は追加AI呼出しを増やさず、完成画像の可視body/手領域を先に観察→元IDへ対応する検査。候補`tsc001-fix\output-first-inspection-stage-20261019`を固定済み。5fixture、12pure tests・型検査PASS、dry-runは送信0。明示executeでも最大5call・retry0。**本体未適用・実送信まだ0**。
- 予防側も、動かした元の手を旧位置に残さない局所指示等を検討中。固定座標・特定シーンの例外・勝手な左右固定は避ける。プロンプト本体はまだ変えていない。
- TSC-001固定はUI受入用の一時状態。一般品質改善ではTSC002/003と利用可能な追加シーンを対照に使い、単一シーン成功を一般化しない。

## 安全な継続・再起動

- `scripts/safe-restart.ps1`はactive captureが無ければNodeを再起動し、HTTP復旧時刻と停止秒数を出す。直近は4〜5秒。
- 自動chainは境界が短いため、担当ノートでGUI Pause→holdtrue＋idleを確認し再起動、その後GUI Enableで元稼働へ戻してきた。
- ユーザーが触った最新mappingを開始時に保存して戻す。古いテストbaselineで後から上書きしない。
- サーバー状態確認：GET `/api/capture/status`、`/api/td-control/state`、`/api/browser-outputs`。読み取りだけで運転を変えない。
- 画像生成・Ollama評価の実測と、mock/pureテストのPASSを区別して報告する。
- ノート側引継ぎ：私有ファイル`C:\Users\nmrei\Downloads\CLAUDE-HANDOVER-20261019.md`（ノート担当が更新しTaildropで再送する）。

## 04:17時点の追記（検証進行中）

- v40cを本体へ適用。Bの折返し経路が自分のAカードを横切る場合のみ左へ迂回する。25/25 tests PASS、実ブラウザー受入待ち。
- v41を本体へ適用。Follow latest初期OFF、Latestボタンは一度だけ末尾へ移動する。構文検査PASS、実ブラウザー受入待ち。
- 人物参照の限定実生成1batch開始：test-TSC-001-F002-L001-1792351018947、04:16:58 JST。設定時F001から受付時F002へ進んだ。保存NOW画像をrootで実見し元人物1人を確認。顔上部は画角外で、顔同一性の検証条件は弱い。F001での成功とは記録しない。
- AのContinuous/OneShotに同UUIDを設定。受付後OneShot空・Continuous1件保持をstateで確認。生成結果・品質・所要時間は未確定。hold true継続中。

## 04:19追記：実受入と参照生成の結果

- v40c実ブラウザーPASS：旧runのB経路71件は全SOURCE起点一致、自分のAカードとの交差0。折り返しケースを含め曲線/segmentを99点で評価。
- v41実ブラウザーPASS：再読込直後Follow false、Latest操作後もfalse。上へ手動移動した位置を4秒のpoll越しに保持。
- 人物参照実生成は **失敗**。capture test-TSC-001-F002-L001-1792351018947。gen_aで「Missing, duplicate, unrequested or uncertain cast identity」として非公開。B/C未生成。
- rootが元NOWと失敗Aを実見。元人物1人に別人1人を追加する期待に対して、結果は1人のまま。元のピンク髪・青緑服へ参照の短い巻髪/ヘッドホンが混ざり、追加人物ではなく顔/髪の混同になった。検査のrejectは妥当。
- 実測：モデル生成16.643秒、画像復元まで17.266秒、受付からbatch失敗まで51.320秒、archive vlmMs10.233秒。3枚成功時の速度とは扱わない。
- 失敗画像/trace：private data experiments/turbo-app-e2e/fbb5cdd4-eecc-4932-ba8d-c3850141db6d/。display.png/model-native.png/workflow.json/trace.jsonを保持。
- UI upload/Apply/reload、同UUIDをContinuousとOneShotで指定し受付後Once空/Continuous保持は成功。人物追加の生成品質は未解決。追加の実生成は実施せず、ノート側へテスト設定を戻して元auto復帰を依頼済み。
## 参照目的の訂正：同じ会場・別時刻の場面全体

ユーザーの目的は、基本的に同じ場所で撮影した別時刻の映像を使い、人物・物・場面の状態を自然に混ぜること。顔cropから別人identityだけを追加する機能に狭めた解釈は誤り。先の顔crop失敗は過去の診断例で、標準素材ではない。現行Person image専用の全参照人物単純加算・背景/物import禁止という契約はこの一般用途に不十分。

まず広いUI改修に先行して限定サンプル1枚を依頼された。同会場TSC001-F005全景（青緑服の人物1人）をSOURCE、F009全景（別の黒服人物1人、白丸バッグと黒い板状機器）を参照とし、SOURCE人物を残して計2人の自然な場面にする。顔cropなし。Turbo同8step/CFG1、独立非公開runnerで生成し、既存参照人物検査と原画目視を記録する。通常公開ガードを無効化しない。結果はまだ未確定。
## 全景混合サンプル：1回実生成の結果

- 2026-10-19、TSC001-F005 SOURCE＋F009全景REFの1枚試験を実行。顔crop/追加identity入力なし、Turbo8step/CFG1/denoise1。生成・検査各1回、公開なし、本体コード/通常設定変更なし。
- runner/evidence：C:/Users/nmrei/claude-code/tsc001-fix/whole-scene-union-sample-20261019/。manifest.jsonに原画SHA、全文指示とseed11047。sample-run/generated-restored.png、result.json、artifacts内workflow/native/traceを保持。
- 実画像でSOURCE青緑服人物が残り、REF黒服人物＋白丸バッグ＋黒板状機器が左前に加わった。顔を1人へ混ぜた前回より目的に近い。ただしREF人物の顔の変化、元写真の画角外にあった頭上部の補完、背景細部変化がある。完全な同一性/背景保存の成功とはしない。
- 実測：モデル8.085秒、復元まで8.788秒、検査まで20.889秒。シナリオ生成/通常3枚batchを含む速度ではない。
- 既存reference-aware検査はguardAccepted true。しかし出力のleft-to-right identity順はsource/refが目視順と逆で、集合一致だけで通っている。人物2人の保持は目視でも確認したが、個別ID対応の検査精度は未解決として扱う。
- 元原画2枚/結果/prompt/resultをwhole-scene-mix-sample-20261019.zipでノートへTaildrop済み。試験後GUI Enableで元chain復帰を依頼。追加試行なし。
- 全景sample後、rootでもchain/hold false/generatingを確認。元auto復帰済み。
