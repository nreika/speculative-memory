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

