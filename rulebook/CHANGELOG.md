# ルールブック変更履歴

新しい順ではなく追記順。自動改善（server/qa/improver.ts）と手動の変更が入る。

## v2 — 2026-10-16T13:00:17.201Z（自動）
- 元: v1、対象の不良: fabricated_object（不良率 22.4%、直近 30 撮影）
- imagePrompt.extraConstraints に追加: Only alter existing objects; never add new ones not present in original photo.
- 検証: 次の 30 撮影で v1 より不良率が +5 ポイント以上悪ければ自動で戻す

## v3 — 2026-10-16T14:07:35.272Z（ユーザー承認）
- 元: v2。G-14（持ち物を維持）と G-15（見えていない顔を新しく描かない）を固定ルールとして追加: imagePrompt.holdingsRule / noNewFaceRule、negative.added に 2 件、vlm.extraInstructions に 1 文。
- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。

## v4 — 2026-10-16T15:25:26.366Z（自動）
- 元: v3、対象の不良: fabricated_object（不良率 29.5%、直近 30 撮影）
- imagePrompt.extraConstraints に追加: Do not introduce objects not visible in original photo.
- 検証: 次の 30 撮影で v3 より不良率が +5 ポイント以上悪ければ自動で戻す

## v5 — 2026-10-16T16:38:21.081Z（自動）
- 元: v4、対象の不良: fabricated_object（不良率 34.4%、直近 30 撮影）
- imagePrompt.extraConstraints に追加: Never add objects not visible in original photo, even if implied by context.
- 検証: 次の 30 撮影で v4 より不良率が +5 ポイント以上悪ければ自動で戻す

## v6 — 2026-10-16T17:50:48.095Z（自動）
- 元: v5、対象の不良: fabricated_object（不良率 33.3%、直近 30 撮影）
- imagePrompt.extraConstraints に追加: Do not add objects not visible in original photo, even if implied by context.
- 検証: 次の 30 撮影で v5 より不良率が +5 ポイント以上悪ければ自動で戻す

## v7 — 2026-10-16T19:01:23.375Z（自動）
- 元: v6、対象の不良: fabricated_object（不良率 30.0%、直近 30 撮影）
- negative.added に追加: added objects, extra objects that are not in the original, new furniture, new bags
- 検証: 次の 30 撮影で v6 より不良率が +5 ポイント以上悪ければ自動で戻す

## v8 — 2026-10-16T20:11:46.893Z（自動）
- 元: v7、対象の不良: fabricated_object（不良率 31.1%、直近 30 撮影）
- imagePrompt.extraConstraints に追加: Only modify existing objects; never add unseen items, even implied by context.
- 検証: 次の 30 撮影で v7 より不良率が +5 ポイント以上悪ければ自動で戻す

## v9 — 2026-10-17T03:43:35.091Z（ユーザー承認）
- 元: v8。G-16（画面・表示物に新しい文字・数字・時計・UI を描かない: imagePrompt.noNewTextRule、negative.noNewText は時計ずらしのないときだけ）と G-07 補足（遮蔽時は遮蔽物と構図を維持: imagePrompt.obstructedRule、遮蔽と判定された撮影だけ）を追加。
- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。

## v10 — 2026-10-17T03:52:21.733Z（ユーザー承認）
- 元: v9。G-07 補足 2（遮蔽物の奥の物を手前に出さない・輪郭をくっきりさせない）: imagePrompt.obstructedRule に 1 文、negative.obstructed（遮蔽と判定された撮影だけ）を追加。根拠: Gen_b_2026-10-17_12-49-13（-541 B）。
- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。

## v11 — 2026-10-17T04:10:39.288Z（ユーザー承認）
- 元: v10。G-07 補足 3: 遮蔽と判定された撮影では、画像プロンプトの先頭に「遮蔽物（obstructedBy）が画像の最前面で、透けて見える物はぼやけて暗いまま」の文を置く（imagePrompt.obstructedLeadRule）。実験 scripts/obstruct-ab.ts（同 seed・同プロンプト）で、現行はモニターがメッシュの手前に出る・先頭に置くと奥に収まる・denoise 0.6 も収まる（不採用）。
- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。

## v12 — 2026-10-17T04:30:31.542Z（ユーザー承認）
- 元: v11。G-17: 画像プロンプトに「レンズフレア・光条・虹色の線・光彩・きらめきを描かない」（noLightArtifactRule、両テンプレート）、無人時は「明るさと色温度だけが変わる」（emptyRoomLightRule）、toneImage.emptyRoom の 4 段階から「影が動く・長い影」等の光の形状変化を除去、負のプロンプトと計画への 1 文を追加。
- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。

## v13 — 2026-10-17T04:46:54.207Z（G-17 の修正）
- 元: v12。v12 の「No lens flare, no light streaks, no rainbow lines…」は、名指しした虹色の光条をむしろ描かせた（同 seed の実験: v12 再現=光条あり、肯定表現に置換=光条なし。人物語の否定文 G-01 と同じ逆効果）。noLightArtifactRule を肯定表現「The lighting stays natural and soft, exactly like an ordinary unprocessed photograph.」に置換、計画への 1 文も光条等の語を使わない言い方に変更。


## v18 — 2026-10-18（G-20 ユーザー指示）
- 椅子は動くことがあるという指示に合わせ、無人時の全物体移動禁止、全画面pixel-identical要求、可動前景の一律位置固定を撤去。
- 建築・画角・露出・照明・ホワイトバランス・画面内容は維持。既存可動物の自然な移動・回転は、個数・同一性・物理的連続性を保つ条件で許可する。人体・持ち物・人物数の固定制約と人物の動作量は維持。
- 椅子を元位置へ貼り戻す処理、元画像への差し替え、追加推論は導入していない。ルールブックを変更したことだけで生成品質改善済みとは扱わない。
- 最終planner/imageプロンプトの矛盾と人物動作維持をテスト。root本体で関連74テストと型検査を確認。実画像の追加回帰は継続。

## v19 — 2026-10-19T03:37:24.618Z（ユーザー依頼「動作が出ない件、調べて直して」）
- 元: v18。G-15 は維持したまま noNewFaceRule を変更: 動作に必要な頭・視線の動き（見る、少し向きを変える）は許可し、入力で見えていない顔は出さない（後ろ姿は後ろ姿、画面端で切れた頭は切れたまま）。「a side profile stays a side profile」の固定を削除。
- G-14 は維持したまま holdingsRule の「Preserve the original grip during the requested movement」を「持った物は同じ手に残り、その手と一緒に動く。手を足さない」に置換（動かすなと読まれていた）。
- extraConstraints のほぼ同文 5 文（物を足さない）を 1 文に統合。照明・ホワイトバランス・人数・同一性・持ち物の制約は変更なし。
- 書き出しのみ（未有効化）。有効化: scripts/rulebook-add-motion-v19.ts --activate-existing
- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。
