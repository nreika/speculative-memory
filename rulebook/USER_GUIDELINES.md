# プロンプト生成のユーザーガイドライン（固定制約）

ユーザーの指摘・判断を、プロンプト生成（VLM の計画指示と画像生成エンジン用プロンプト）の固定制約として集約したもの。
**自動改善（ルールブックの自動更新）はこの節の項目を変更・削除してはならない。** 変えるときはユーザーに確認する。
新しいユーザー判断が来たら、その都度ここに追記する（出典の発言と日付、反映先のエンジン用の文を必ず書く）。

項目の形式: ID / 日付 / ユーザーの発言（原文） / 意味 / 反映先（VLM 指示・画像プロンプト・負のプロンプト・ガード）/ エンジン用の文。

---

## G-01 人物を勝手に出さない（直近にいた人だけ許容）
- 日付: 2026-10-15
- 原文: 「人物だすときは、近いタイミングで人がうつってたら、その人をだすのであればまあいい。ずっとだれもいないのに、全然知らん人をぽっとださないでね」
- 意味: 無人の部屋に見知らぬ人物を生成しない。直近（既定 10 分、`RECENT_PERSON_WINDOW_MIN`）に写っていた人物に限り登場させてよい。
- 反映先: ガード（人物捏造の検知・再試行・差し替え）、VLM 指示（無人なら人物に一切言及しない）、画像プロンプト（無人テンプレートは人物語ゼロ）、負のプロンプト（person, people, human figure, silhouette, shadow person, dark figure, mannequin）。
- エンジン用の文（無人時）: 人物語を一切使わない（否定文も含む）。`This is an unoccupied room. Change only: <prediction>. Keep every object, the furniture, the camera and the framing identical to the input. Preserve the empty floor and the empty chairs exactly as they are.`
- 補足（派生ルール、2026-10-15）: 否定文の人物語（"do not add any person"）も画像モデルには「人を描け」と効くため、無人時は否定文も禁止。

## G-02 直近の人物を出すときは後ろ姿で、同じ服装・髪型
- 日付: 2026-10-16
- 原文: 「顔が映ってないんだったら、基本的に、後ろ姿とかにすればいい」（G-01 の「その人をだすのであれば」への補足。画像モデルが顔の同一性を保てないため）
- 意味: 直近 10 分ルールで人物を登場させるときは、顔を見せず後ろ姿にし、服の色と形・髪型・体格を直前フレームの人物に合わせる。直前フレームの人物の切り出しを参照画像（image2）として渡す。
- 反映先: VLM 指示、画像プロンプト、負のプロンプト、参照画像。
- エンジン用の文: `The person is seen from behind with their back turned to the camera; the face is not visible. Same clothes: <clothes>, same hair: <hair>, same build as the person in the reference image.`
- 負のプロンプト: `face visible, looking at camera, frontal face`
- QA 分類: 直前の人物と服装が違う場合は `mismatch` として数える。

## G-03 無人なら人物の動作の追加指示（extras）は無効
- 日付: 2026-10-16
- 原文: 「人がいない場合は、『帰ろうとしている』は無効でいいからね」
- 意味: シーン別の追加指示（sceneExtras）が人の動作・感情を指すとき、無人判定なら無視する（ログ `[extras]` に理由）。
- 反映先: ガード（extras の適用条件）。
- 補足（2026-10-16 決定）: 直近 10 分ルールで人物を出す場合（検出器は無人）も extras は適用しない。人物は後ろ姿で控えめな動作（静かに立つ/座る/ゆっくり歩く/振り向く）に限る。ログ `[extras] ignored: frame empty (recent person drawn from behind)`。

## G-04 動作は「写っている本人」がする。体の一部を物から生やさない
- 日付: 2026-10-15
- 原文: 「両手をあげて万歳、不自然。オリジナルでうつってる人がやらないと。椅子から手をはやさないで」
- 意味: 追加指示の動作は元フレームに写っている人物（同一人物・同じ服・同じ位置）が行う。腕や手だけを家具から生やさない。
- 反映先: VLM 指示（extras は「写っている本人」の具体的な動作 1 文に書き換え）、画像プロンプト、負のプロンプト。
- エンジン用の文: `THE PERSON ALREADY VISIBLE IN THIS FRAME (same person, clothes, position) <action>. Do not add disembodied body parts; arms and hands must belong to a visible person; never attach limbs to furniture or objects.`
- 負のプロンプト: `disembodied hands, floating arms, limbs growing from furniture`

## G-05 追加指示はそのシーンの「主な出来事」として必ず反映
- 日付: 2026-10-16
- 原文: 「帰ろうとしてる、の指示が聞いてない」「A、追加指示がきいてない」
- 意味: 追加指示のあるシーンでは、小さな動作や Tone の指示より追加指示を優先し、必ず反映する。4B モデルの yes/no 判定は信用せず、サーバーが具体化した英文（例: 立ち上がって荷物を持ち出口へ向かう）を prediction_prompt に採用する。
- 反映先: VLM 指示（`Scenario N (gen_x): the MAIN EVENT of this scenario is "<extra>"`）、サーバー合成（`rewriteExtraEnglish`）、表示文はその英文の日本語訳。

## G-06 カメラ手前の物は実寸・輪郭を保つ（巨大化させない）
- 日付: 2026-10-16
- 原文: 「黒いメッシュの椅子、むちゃくちゃおおきいものとして処理されてない？」「椅子の指示文の修正も頼んで」
- 意味: 画面の大部分を占める手前の物（事務椅子の背もたれなど）を、帆や壁のような巨大な構造物にしない。
- 反映先: VLM 指示（`foreground_object` を実寸と距離つきで返す）、画像プロンプト、負のプロンプト。
- エンジン用の文: `Near-camera foreground object (<foreground_object>) keeps its real-world scale, outline, position and texture exactly as in the input; do not enlarge, bend, inflate or turn it into a wall, sail or sculpture.`
- 負のプロンプト: `giant mesh, oversized foreground object, warped mesh, inflated chair, moire`
- 補足: 根本対策はカメラ位置（背もたれから離す・高さを上げる）。

## G-07 物は物理的に妥当な場所に。勝手に物を足さない
- 日付: 2026-10-16
- 原文: 「椅子の背もたれにラップトップって不自然」「B、映像変だよ」（元写真に無い椅子・ジャケット・トートバッグが足され、ノート PC が宙に浮いた）
- 意味: 写真に無い物を足さない。物は重力と支持が成り立つ位置に置く（ノート PC やカップは机の上、バッグは床か座面。背もたれに掛からない・浮かない）。
- 反映先: ガード（シナリオの物が scene_description に無ければ捏造として再試行・差し替え。検出器が無人なら scene_description の人物も幻覚扱い）、画像プロンプト（有人・無人とも）、負のプロンプト。
- エンジン用の文: `Do not add any object that is not in the photo; every object stays exactly where it is. Objects rest on surfaces in physically plausible positions (laptops and cups on desks, bags on the floor or a chair seat); nothing hangs on a chair back or floats in the air; gravity and support stay realistic.`
- 負のプロンプト: `floating object, object hanging on chair back, levitating laptop, extra chair, additional bag, added furniture`

- 補足（2026-10-17）: カメラが手前の物（椅子の背もたれ等）で遮られていると判定された（describe の obstructed=true）撮影では、遮蔽物を含む元の構図を維持し、遮蔽物を取り除いた裏の部屋や明るい別の部屋を新しく描かない。根拠: Gen_b_2026-10-17_05-29-43（元は暗い会場で背もたれが画面の 7 割を塞ぐのに、B は椅子を消して明るい部屋を新規に描いた）。反映先: 画像プロンプト（`obstructedRule`、obstructed のときだけ）、QA 分類 `obstruction_removed`。エンジン用の文: `A large object right in front of the camera (such as a chair backrest) blocks much of the view in the input: keep that object and the whole composition exactly as in the input; do not remove it and do not draw the room behind it or a new, brighter room.`

- 補足 2（2026-10-17、遮蔽時の前後関係）: 遮蔽物の奥にある物は、遮蔽物より手前に出したり、輪郭をくっきりさせたりしない。入力で透けて見える程度（ぼやけ・暗さ・メッシュ越しの質感）をそのまま保つ。根拠: Gen_b_2026-10-17_12-49-13（td-…-541 の B。元は椅子の背もたれのメッシュの奥にモニターが黒い四角としてぼんやり透けているだけなのに、生成ではモニター 2 台がメッシュの手前にくっきり貼り付いた）。反映先: 画像プロンプト（`obstructedRule` の後半、obstructed のときだけ）、負のプロンプト（`negative.obstructed` = sharp monitor in front of the mesh, objects in front of the chair back, objects pasted on top of the obstruction。obstructed のときだけ）、QA 分類 `depth_order_broken`。エンジン用の文: `Things behind the obstruction stay behind it: do not bring them in front of the obstruction or make their outlines sharper; keep them exactly as hazy, dark or mesh-filtered as they appear in the input.`

- 補足 3（2026-10-17、遮蔽物を最前面と明示。実験で確認）: 遮蔽と判定された撮影では、画像プロンプトの**先頭**に「遮蔽物が画像全体の最前面で、それ越しに見える物はぼやけて暗いまま」の文を置く（遮蔽物の名前は describe の obstructedBy、不明なら near-camera obstruction）。根拠: scripts/obstruct-ab.ts（元 record_2026-10-17_12-54-52、B 条件、seed 固定）。現行 v10 はモニター 2 台がメッシュの手前に出る、この文を先頭に置くと奥に収まる（所要 28.7 秒、速度コストなし）、denoise 0.6 も収まるが不採用。Lightning（cfg 1.0）では負のプロンプトが無効なので、画像プロンプト側で対処する。反映先: 画像プロンプト（`obstructedLeadRule`、有人・無人の両テンプレートの先頭、obstructed のときだけ）。エンジン用の文（メッシュ以外は through it / its pattern）: `The mesh chair backrest is the frontmost layer of the whole image; everything seen through the mesh stays dim, blurred and partially hidden by the mesh pattern, exactly as in the input.`

## G-08 無人時の変化は環境的なものに限る
- 日付: 2026-10-16（G-07 の派生。「ジャケットが引き出される」など人手前提の物の動きが無人で描かれた件）
- 意味: 無人のシナリオは光・影、カーテンの揺れ、画面表示、点灯/消灯、窓外の明るさなどに限り、人の手が要る移動・出し入れ・開閉・回転は書かない（椅子の回転も禁止）。
- 反映先: VLM 指示の無人節、サーバーの無人テンプレート（差し替え用）。

## G-09 表示文はシンプルに、エンジン用プロンプトは詳細に
- 日付: 2026-10-16
- 原文: 「TDに出てるプロンプトはシンプルだけど、生成エンジンに渡すプロンプトは、もっと複雑なはず（自然な映像にするためには）」
- 意味: TD に出す表示文（scenario_description の日本語）は短く、画像生成に渡すプロンプトは自然な映像になるよう固定制約・品質文を含めて詳しく書く。両方の全文をアーカイブ（prompts.json）と /logs で見られるようにする。
- 反映先: 分離の維持（表示文 ≠ 画像プロンプト）。

## G-10 自然さの基本制約（10-15 以前からの既存ルール、出典: docs/HANDOVER.md 10-06〜10-07 の記録）
- 意味: 腕は 2 本・手は 2 つ、人物の重複なし、移動した人物の元の位置は消す、モニター・画面・家具の数と画面内容は変えない、「写っている物だけ」を使う（hardRule）、長期間（≥120 秒）でも背景はピクセル単位で同一、時計は桁だけ変える。
- エンジン用の文: `Sharp, crisp, high-detail photo, in focus edge to edge, fully solid opaque people, no transparency, no ghosting. Keep the exact same number of monitors, screens and furniture as the input. Each person has exactly two arms and two hands. When a person moves, redraw them in the new pose and at the new spot only; their previous position must disappear completely. No duplicated limbs, hands or people.`（有人テンプレート。無人テンプレートでは人物語を除いた版）

## G-11 大きな腕の動作は extras が明示したときだけ
- 日付: 2026-10-16
- 原文（ノート経由のユーザー指摘）: 「万歳」と同系統で不自然（両手を上げる・伸びをする・手を振るなどの大きな腕の動作）。出典の原文は G-04「両手をあげて万歳、不自然。オリジナルでうつってる人がやらないと」。
- 意味: 計画（VLM）は大きな腕の動作を選ばない。許すのは姿勢の小さな変化、座る/立つ、歩く、振り向く程度。サーバーは prediction_prompt に該当語（raise both hands/arms overhead, stretch, wave 等）があれば 1 回再試行し、残れば控えめな動作に差し替える。extras がそう指示したシーンは除く。
- 反映先: VLM 指示、ガード（hasBigArmMotion）、負のプロンプト（arms raised overhead, stretching arms up, waving）。

## G-12 直近人物は元の位置・同じ縮尺で（手前に大きく出さない）
- 日付: 2026-10-16
- 原文（ノート経由のユーザー指摘）: 手前に大きすぎる（直近の人物が画面いっぱいに描かれた）。G-06（カメラ手前の物は実寸）の人物版。
- 意味: 直近 10 分ルールで出す人物は、元の位置（people 記述の position）に、参照画像と同じ縮尺で、部屋の中〜奥の全身として描く。カメラに近づけない・画面を埋めない。後ろ姿（G-02）と併用。
- 反映先: 画像プロンプトの behindViewSentence（1 か所）、負のプロンプト（giant person, person too close to camera, oversized figure, cropped body filling frame）、prompts.json の behindView / scaleRule。

## G-13 髪型・髪の長さ・髪の色は変えない
- 日付: 2026-10-16
- 原文（ノート経由のユーザー指示）: 「ガイドラインに、髪型、髪の色を変えないように指示して。」
- 実例（2026-10-16, td-1792127507452-67 の B）: 短い黒髪の人物が、肩より長い髪に変わって描かれた。
- 意味: 写っている人物（直近 10 分の人物を後ろ姿で描く場合も含む）の髪型・髪の長さ・髪の色は元画像（と参照画像）と同一に保つ。extras に明示がない限り変更しない。固定ルール（自動改善の対象外）。
- 反映先: 画像プロンプトの固定制約（有人テンプレートと behindView 文、定数 HAIR_RULE）、負のプロンプト（hair color change, different hairstyle, changed hair length）、VLM 指示（髪型・髪色は変えない）。
- 予約 QA 分類名: `hair_mismatch`（継続 QA 側で「髪型・髪色が元と一致」を判定する。ここでは名前の予約のみ）。

## G-14 持ち物を維持する（元画像で人物が持っている物を消さない）
- 日付: 2026-10-16（候補 C-01 をユーザーが採用）
- 原文: 「候補 C-01 持ち物を維持する」を採用（ユーザー承認、親セッション経由）。根拠の撮影: 2026-10-16_14-24-41 の B（td-…-73、持っていたマイクが消えた。継続 QA の既知の不良例で、missing_object として検出済み）。
- 意味: 元画像で人物が持っている・身につけている物（マイク、スマホ、カップ、バッグなど）が、生成で消えたり別の物に変わったりしない。
- 反映先: 画像プロンプト（`holdingsRule`）、負のプロンプト（item removed from hands, missing held item）、VLM 指示（人物が持つ物を消さない）、QA 分類 `lost_belongings`。
- エンジン用の文: `Items a person holds or carries in the input (for example a microphone, phone, cup or bag) stay in their hands or on them in the same form; none of them disappears, is replaced or is put down unless the instruction says so.`

## G-15 元画像で見えていない顔を新しく描き起こさない（振り向かせない）
- 日付: 2026-10-16（候補 C-02 をユーザーが採用）
- 原文: 「候補 C-02 元画像で見えていない顔を新しく描き起こさない（振り向かせない）」を採用（ユーザー承認、親セッション経由）。根拠の撮影: 2026-10-16_14-29-22 の C（td-…-75、右寄りの元位置から中央へ移動し正面の顔を新規に描画）。
- 意味: 後ろ姿や横顔の人物を、顔が見える向きに振り向かせて顔を新規生成しない。G-02（直近の人物は後ろ姿）と同系統。
- 反映先: 画像プロンプト（`noNewFaceRule`）、負のプロンプト（newly drawn face, face turned to the camera）、VLM 指示、QA 分類 `new_face`。
- エンジン用の文: `Do not draw a face that is not visible in the input: a person seen from behind or in profile stays turned away and does not turn to show the face; never create a new frontal face.`

## G-16 画面・表示物に新しい文字・数字・時計・UI を描かない
- 日付: 2026-10-17
- 原文（ユーザー、親セッション経由）: 「B Futureが明らかに違うし、文字化けした時計をたくさん出すのやめて」
- 根拠の撮影: Gen_b_2026-10-17_05-29-43（元 record_2026-10-17_05-28-24）。ノート PC 4 台の画面に「12:35」風の文字化けした時計が描かれた。
- 意味: 元に無い文字・数字・時計・UI を足さない。元の画面の内容は維持するか、暗いままにする。数字をずらしてよいのは、元画像に実際に写っている時計・数字札だけ（既存の時計ずらし clockEdit と同じ条件）。
- 反映先: 画像プロンプト（`noNewTextRule`、有人・無人の両テンプレート）、負のプロンプト（`negative.noNewText` = clock, digits, text on screen, garbled text, numbers。時計ずらしがあるときは入れない）、QA 分類 `new_text_or_clock`。
- エンジン用の文: `Do not add any new text, numbers, clock or user interface to any screen, sign or surface that is not in the input; every screen keeps exactly the content it has in the input, or stays dark if it is dark. The only digits that may change are on a clock or number sign that is already visible in the input.`

---

## 運用上の判断（プロンプトの文言ではないが、ガイドラインとして蓄積）

- **R-01 テスト撮影の表示**（2026-10-16、原文「過去の、良さそうな画像で、いろいろテストするのはいいよ。その代わり、テスト画像使用中、という風に表示しておいて」）: テスト撮影は `test:true` で送り、TD には赤帯「テスト画像使用中」を出す。latest*.json・履歴・会場サマリーは更新しない。
- **R-02 ルールブックの自動改善**（2026-10-16、原文「自動で反映し続けて。こまったら聞いて。」）: 自動適用して版を上げる。不良率が前版より悪化（+5 ポイント）したら自動で前版に戻す。1 回の更新は少数項目で、変更は /logs に残す。表現に関わる変更（変化の大きさ、人物の有無、トーン）や何版も改善しない不良は自動適用せず、ユーザーに聞く。**本ガイドライン（G-xx）は自動改善の対象外。**
- **R-03 ガイドラインの蓄積**（2026-10-16、原文「そういうのも、プロンプト生成のためのガイドライン、にいれていって」）: ユーザーの新しい判断は、その都度この文書に追記する。/logs でガイドラインの一覧と追加履歴を見られるようにする。

## 追加履歴
- 2026-10-16: 初版（G-01〜G-10、R-01〜R-03）。
- 2026-10-16: G-11・G-12 を追加、G-03 に補足（直近人物を出す場合も extras は無効）。
- 2026-10-16: G-13（髪型・髪の長さ・髪の色は変えない）を追加。
- 2026-10-16: 候補 C-01・C-02 を採用し G-14（持ち物を維持）・G-15（見えていない顔を新しく描かない）に昇格。
- 2026-10-17: G-16（画面・表示物に新しい文字・数字・時計・UI を描かない）を追加、G-07 に補足（遮蔽時は遮蔽物と構図を維持）。
- 2026-10-17: G-07 補足 2（遮蔽物の奥の物を手前に出さない・輪郭をくっきりさせない）を追加。
- 2026-10-17: G-07 補足 3（遮蔽時は遮蔽物を最前面と明示する文を画像プロンプトの先頭に置く）を追加。

---

## 候補（未確定）
固定ルールではない。ユーザーの確認が取れたら G-xx に昇格する。

（現在なし。C-01 は G-14、C-02 は G-15 に昇格済み）
