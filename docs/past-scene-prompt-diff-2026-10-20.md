# Past-scene (C) prompt diff, 2026-10-20 (G-26)

User complaint (16:2x): 「過去のPROMPTが、全然過去ではない」. The C scene (distance −30 s) was written as a change that ends in the present ("…, now they have lowered…" / 「今では…」), or as a new generic action, not as the earlier state that led into the captured frame.

Root cause: the planner got only a one-line rewind hint (gemini-prompts.json `rewindGuidance`); JSON_INSTRUCTION (server/generation/vlmClient.ts) told every scenario to describe "the new actions … that change from the given frame", with nothing past-specific; the display text is made from prediction_prompt (`withEnglishSpan` + translation) with no tense rule; the image prompt (compactPeople / generic / empty-room templates) and the "Main change" line framed every scene as a forward edit; the empty-room object change was the same forward change for −30 s.

Generated offline by `npx tsx scripts/past-scene-diff.ts <archive dirs>` (no VLM / ComfyUI call). The planner's own output can only be judged live: the new contract changes what the VLM writes; below, the sanitisers / templates are applied to the archived C texts, and the STATE LEDGER is rebuilt from logs/scene-history.jsonl at each capture time.

## New planner contract (added for every scenario with a negative distance)

```
PAST-SCENE CONTRACT for Scenario 3: this frame is the END state. Scenario 3 must show the room as it plausibly WAS 30 seconds earlier, the moment that led into this frame, causally consistent with it (same people, same belongings, same places; nothing that could not become this frame within 30 seconds). First decide from HISTORY and the STATE LEDGER (when given) whether the current activity or state started within the last 30 seconds. If it was already going on before that (the same activity appears in HISTORY for longer than 30 seconds, e.g. the person has been eating for 10 minutes), the SAME activity was already going on: show a slightly earlier moment of it (one bite earlier, the cup a little lower, the hands in a slightly different position), never the unopened, closed, packed-away or absent state. If HISTORY is missing or unclear, use the SMALLEST coherent difference (a slightly earlier moment of the same state), never a bold reversal. Only if HISTORY shows the state is NEW (it began within about twice 30 seconds) reverse the most recent action or state change: if a person is eating something now, earlier the item was still unopened or still inside its paper bag; if a cup is at the mouth now, earlier it was still on the desk; if a bag is open now, earlier it was still closed. Never invent a new or unrelated action. Write its prediction_prompt as the earlier state itself (e.g. "The cup is still on the desk next to her right hand; both her hands rest on the desk."), never as a change that ends in the present: no "now", "currently", "at present", "originally ... now", "has lowered", "then", "will". Its scenario_description is that earlier state in the past tense (e.g. "30 seconds before, the cup was still on the desk."). (User guidance G-26: 「たとえば、何かを食べている場合、それが未開封になってるとか、紙袋にはいってるとか、ならわかる」 / 「ただ、常に未開封だと、変。すでに10分以上食事しているときに、その３０秒前が常に未開封なシーン、だと不自然。」 / 「整合性のある、あり得た過去・未来を生成するのは、だいぶハイコンテクスト。完全にはできないとおもうけど、ベストエフォートで実装したい」)
```

## 2026-10-20_16-15-26 (C, -30 s)

- history: 7 rows; continuity = **unknown** (container first seen in this frame, but the previous row is older than 2x the span)

| | old | new |
|---|---|---|
| predictionPrompt | The person was originally holding the container with one hand near their mouth, now they have lowered their hand slightly and are holding the container with both hands, looking forward with a neutral expression. | The person is holding the container with one hand near their mouth. |
| display (ja) | 30秒前、人物は元々口の近くで片手で容器を握っていたが、今では手をわずかに下げ、両手で容器を握り、中立の表情で前方を見ている。 | 30秒前、人物は口の近くで片手で容器を握っていた。 (offline: sanitiser on the old text; live, the translation is made from the new English with the past-tense rule) |

<details><summary>planner note added (STATE LEDGER / continuity)</summary>

```
STATE LEDGER (server-built from HISTORY, 7 rows; best effort, the observations may omit things):
- a person present: seen now; this run since 16:13 (2 min), not seen at 16:13
- a person seated: seen now; this run since 16:13 (2 min), not seen at 16:13
- phone: not seen now; last seen 16:06
- jacket: not seen now; last seen 16:09
- bag: not seen now; last seen 16:13
- container: seen now; this run since 16:15 (0 min), not seen at 16:13
- lid: seen now; this run since 16:15 (0 min), not seen at 16:13
FUTURE CONTINUITY: scenarios AFTER this frame continue the activities the ledger shows as ongoing (the next moment of the same activity); they do not restart them.
PAST CONTINUITY (server check): unclear (container first seen in this frame, but the previous row is older than 2x the span). In every scenario BEFORE this frame use the SMALLEST coherent difference: a slightly earlier moment of the same state, never a bold reversal.
```
</details>

<details><summary>imagePromptFull old</summary>

```
Edit the existing single person in image1. Replace the original pose with this action: The person was originally holding the container with one hand near their mouth, now they have lowered their hand slightly and are holding the container with both hands, looking forward with a neutral expression. The white t-shirt with pink trim person continuously keeps black container with white lid in both hands, with the original hand grip. All their worn or hanging items stay attached and visible (black wristband). Exactly 1 original person remains in the entire image, each appearing once. Original person 1: white t-shirt with pink trim, right front, facing side. Keep this individual in the same right front area and replace only their current pose. Keep black container with white lid in both hands with this owner, in the same hand; the item moves together with that hand. Keep black wristband attached.  Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main change that must be clearly visible: The person was originally holding the container with one hand near their mouth, now they have lowered their hand slightly and are holding the container with both hands, looking forward with a neutral expression.
```
</details>

<details><summary>imagePromptFull new</summary>

```
This image is the moment 30 seconds BEFORE this photo; the photo shows what happened next. Render that earlier moment: undo the most recent small action rather than adding a new one. Keep the same people count, identities, clothes, hair, belongings, framing, camera and lighting as in the photo.

Edit the existing single person in image1. Replace the original pose with this action: The person is holding the container with one hand near their mouth. The white t-shirt with pink trim person continuously keeps black container with white lid in both hands, with the original hand grip. All their worn or hanging items stay attached and visible (black wristband). Exactly 1 original person remains in the entire image, each appearing once. Original person 1: white t-shirt with pink trim, right front, facing side. Keep this individual in the same right front area and replace only their current pose. Keep black container with white lid in both hands with this owner, in the same hand; the item moves together with that hand. Keep black wristband attached.  Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main difference from the photo (this is the EARLIER moment): The person is holding the container with one hand near their mouth.
```
</details>

## 2026-10-20_16-13-00 (C, -30 s, empty room)

- history: 6 rows; continuity = **unknown** (no person in this frame)

| | old | new |
|---|---|---|
| predictionPrompt | The white shopping bag is turned a few degrees to the right. | The white shopping bag is still turned a few degrees further to the right than in the photo: its earlier position, before it was turned to the position shown in the photo. |
| display (ja) | 30秒前、白いショッピングバッグが右に数度回転している。 | 30秒前、白いショッピングバッグが右に数度回転していた。 (offline: sanitiser on the old text; live, the translation is made from the new English with the past-tense rule) |

<details><summary>planner note added (STATE LEDGER / continuity)</summary>

```
STATE LEDGER (server-built from HISTORY, 6 rows; best effort, the observations may omit things):
- a person present: not seen now; last seen 16:11
- a person seated: not seen now; last seen 16:11
- phone: not seen now; last seen 16:06
- jacket: not seen now; last seen 16:09
- bag: seen now; this run since 16:13 (0 min), not seen at 16:11
FUTURE CONTINUITY: scenarios AFTER this frame continue the activities the ledger shows as ongoing (the next moment of the same activity); they do not restart them.
PAST CONTINUITY (server check): unclear (no person in this frame). In every scenario BEFORE this frame use the SMALLEST coherent difference: a slightly earlier moment of the same state, never a bold reversal.
```
</details>

<details><summary>imagePromptFull old</summary>

```
Edit this exact photo according to: The white shopping bag is turned a few degrees to the right. Keep the architecture, camera, framing, exposure, lighting colour, white balance, shadows and screen contents unchanged. Keep every original object recognizable with the same identity, count, real-world scale and continuous structure. Move or rotate an existing movable object only as required by the scenario and physically supported by the visible scene; keep unrelated objects in place. Every object comes from the input photo and appears exactly once. Preserve existing objects through the requested movement; never erase, replace, duplicate or invent objects. Keep the number of monitors, screens and furniture, and what each screen displays, identical.

Near-camera foreground objects keep their real-world scale, recognizable identities, continuous shapes and textures. Position or orientation may change only when required by the scenario and physically plausible; otherwise keep them in place. Never erase or duplicate them to expose an unrelated new room.

Objects rest on surfaces in physically plausible positions (laptops and cups on desks, bags on the floor or a chair seat); nothing hangs on a chair back or floats in the air; gravity and support stay realistic. Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Do not add any new text, numbers, clock or user interface to any screen, sign or surface that is not in the input; every screen keeps exactly the content it has in the input, or stays dark if it is dark. The only digits that may change are on a clock or number sign that is already visible in the input.

Keep the lighting exactly as it is in image1.

Keep the original exposure, brightness, lighting colour, white balance and shadow positions identical.

Follow only the requested natural object movement, with the original object identities, counts and physical continuity preserved; keep unrelated objects in place.

Sharp, crisp, high-detail photo, in focus edge to edge. Do not add any new object; every object appears exactly once. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit.
```
</details>

<details><summary>imagePromptFull new</summary>

```
This image is the moment 30 seconds BEFORE this photo; the photo shows what happened next. Render that earlier moment: undo the most recent small object change rather than adding a new one. Keep the framing, camera, lighting and every object's identity and count exactly as in the photo.

Edit this exact photo according to: The white shopping bag is still turned a few degrees further to the right than in the photo: its earlier position, before it was turned to the position shown in the photo. Keep the architecture, camera, framing, exposure, lighting colour, white balance, shadows and screen contents unchanged. Keep every original object recognizable with the same identity, count, real-world scale and continuous structure. Move or rotate an existing movable object only as required by the scenario and physically supported by the visible scene; keep unrelated objects in place. Every object comes from the input photo and appears exactly once. Preserve existing objects through the requested movement; never erase, replace, duplicate or invent objects. Keep the number of monitors, screens and furniture, and what each screen displays, identical.

Near-camera foreground objects keep their real-world scale, recognizable identities, continuous shapes and textures. Position or orientation may change only when required by the scenario and physically plausible; otherwise keep them in place. Never erase or duplicate them to expose an unrelated new room.

Objects rest on surfaces in physically plausible positions (laptops and cups on desks, bags on the floor or a chair seat); nothing hangs on a chair back or floats in the air; gravity and support stay realistic. Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Do not add any new text, numbers, clock or user interface to any screen, sign or surface that is not in the input; every screen keeps exactly the content it has in the input, or stays dark if it is dark. The only digits that may change are on a clock or number sign that is already visible in the input.

Keep the lighting exactly as it is in image1.

Keep the original exposure, brightness, lighting colour, white balance and shadow positions identical.

Follow only the requested natural object movement, with the original object identities, counts and physical continuity preserved; keep unrelated objects in place.

Sharp, crisp, high-detail photo, in focus edge to edge. Do not add any new object; every object appears exactly once. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit.
```
</details>

## 2026-10-20_16-11-48 (C, -30 s)

- history: 7 rows; continuity = **unknown** (a person seated first seen in this frame, but the previous row is older than 2x the span)

| | old | new |
|---|---|---|
| predictionPrompt | The person on the right turns their head to the left and looks at the monitor, while the person on the left turns their head slightly to the left, watching the monitor. | The person on the right turns their head to the left and looks at the monitor, while the person on the left turns their head slightly to the left, watching the monitor. |
| display (ja) | 30秒前、右側の人物が左へ頭を向け、モニターを凝視し、左側の人物はわずかに左へ頭を向け、モニターを観察する。 | 30秒前、右側の人物が左へ頭を向け、モニターを凝視し、左側の人物はわずかに左へ頭を向け、モニターを観察していた。 (offline: sanitiser on the old text; live, the translation is made from the new English with the past-tense rule) |

<details><summary>planner note added (STATE LEDGER / continuity)</summary>

```
STATE LEDGER (server-built from HISTORY, 7 rows; best effort, the observations may omit things):
- a person present: seen now; this run since 16:11 (0 min), not seen at 16:10
- a person seated: seen now; this run since 16:11 (0 min), not seen at 16:10
- phone: not seen now; last seen 16:06
- jacket: not seen now; last seen 16:09
FUTURE CONTINUITY: scenarios AFTER this frame continue the activities the ledger shows as ongoing (the next moment of the same activity); they do not restart them.
PAST CONTINUITY (server check): unclear (a person seated first seen in this frame, but the previous row is older than 2x the span). In every scenario BEFORE this frame use the SMALLEST coherent difference: a slightly earlier moment of the same state, never a bold reversal.
```
</details>

<details><summary>imagePromptFull old</summary>

```
Edit the existing 2 people in image1. Replace the original pose with this action: The person on the right turns their head to the left and looks at the monitor, while the person on the left turns their head slightly to the left, watching the monitor. Exactly 2 original people remain in the entire image, each appearing once. Original person 1: plain shirt, left front, facing toward. Keep this individual in the same left front area and replace only their current pose.    Original person 2: white t-shirt, right front, facing toward. Keep this individual in the same right front area and replace only their current pose.    Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main change that must be clearly visible: The person on the right turns their head to the left and looks at the monitor, while the person on the left turns their head slightly to the left, watching the monitor.
```
</details>

<details><summary>imagePromptFull new</summary>

```
This image is the moment 30 seconds BEFORE this photo; the photo shows what happened next. Render that earlier moment: undo the most recent small action rather than adding a new one. Keep the same people count, identities, clothes, hair, belongings, framing, camera and lighting as in the photo.

Edit the existing 2 people in image1. Replace the original pose with this action: The person on the right turns their head to the left and looks at the monitor, while the person on the left turns their head slightly to the left, watching the monitor. Exactly 2 original people remain in the entire image, each appearing once. Original person 1: plain shirt, left front, facing toward. Keep this individual in the same left front area and replace only their current pose.    Original person 2: white t-shirt, right front, facing toward. Keep this individual in the same right front area and replace only their current pose.    Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main difference from the photo (this is the EARLIER moment): The person on the right turns their head to the left and looks at the monitor, while the person on the left turns their head slightly to the left, watching the monitor.
```
</details>

