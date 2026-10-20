# Motion prompt diff, 2026-10-19 (old archive vs new compose, offline)

Captures 1792377988832, 1792379506138, 1792379927523; scenes A/B/C. No model was called to make this file.

How the new prompt was made:

- Inputs come from each `<ts>_prompts.json`: `vlm.guard.people` (people, pose, holding, holdingFacts), `vlm.guard.detector.count`, `params.presence`, `params.tone`, each scene `sceneExtra` (the Japanese operator instruction) and `distanceSec`. All 9 old prompts used the compact-people template (no clock, not obstructed).
- Reconstruction check: recomposing the OLD predictionPrompt with rulebook v18 and the archived inputs reproduces the archived imagePromptFull exactly, except for the intended code changes (the closing "Main change" line, and "in the same hand; the item moves together with that hand" for a held item). So the inputs are recovered faithfully.
- The new predictionPrompt is rebuilt from `sceneExtra` by the new extras pipeline (exact-phrase dictionary, else translation). The translation call was NOT made: a stub returned the expected meaning-preserving output, which is an approximation of what the model returns:
  - 「椅子に座ったまま机を見る。」 -> "stays seated on the chair and looks down at the desk" (then adapted to the observed pose: a standing person gets "sits on the chair and looks at the desk")
  - 「片手を軽く上げる。」 -> "raises one hand lightly"; 「机に片手を置く。」 -> "places one hand on the desk"
- The new prompt uses rulebook v19 (written by scripts/rulebook-add-motion-v19.ts). The image backend, seed and negative prompt are unchanged.
- Not recoverable: the image itself and the real translation output. 1792379506138 places its single person at "right front" while the operator text says 画面左, so (as before) the subject stays "on the left side of the image" and the actor falls back to the only person.
- Japanese display text (scenarioDescription) is unchanged in all scenes.

## 1792377988832 scene A (2026-10-19_11-46-28, seed 1274558555)

- Operator instruction: 「画面左の人物が、椅子に座ったまま机を見る。」; display text (unchanged): 「15秒後、画面左の人物が、椅子に座ったまま机を見る。」
- Actor pose: standing or leaning; occupied hands from holdingFacts: none; screen-side match: no (single person used); presence 0.734177, tone 0.696203
- Action source: translation -> "sits on the chair and looks at the desk"

Old predictionPrompt:

```text
The existing person on the left side of the image sits down. Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips; never invent extra hands): "画面左の人物が、椅子に座ったまま机を見る。".
```

New predictionPrompt:

```text
The existing person on the left side of the image sits on the chair and looks at the desk. Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips; never invent extra hands): "画面左の人物が、椅子に座ったまま机を見る。".
```

imagePromptFull, sentence-level unified diff (old = archive, new = offline compose):

```diff
--- old (archive, v18)
+++ new (compose, v19)
@@ -1,3 +1,3 @@
 Edit the existing single person in image1.
-Replace the original pose with this action: The existing person on the left side of the image sits down.
+Replace the original pose with this action: The existing person on the left side of the image sits on the chair and looks at the desk.
 Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips;
@@ -19,6 +19,3 @@
 Each person has two arms and two hands.
-Preserve the original head direction and visibility.
-A person viewed from behind remains back-facing with their face hidden;
-a side profile stays a side profile;
-a head cut by the frame remains cut by the frame.
+The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.
 Each held or worn belonging stays with its original owner, with the same shape and size.
@@ -26,11 +23,8 @@
 another person never receives a copy.
-Preserve the original grip during the requested movement.
+A held object stays in the same hand and moves together with that hand during the requested movement;
+never add a hand to free it.
 Only alter existing objects;
-never add new ones not present in original photo.
-Do not introduce objects not visible in original photo.
-Never add objects not visible in original photo, even if implied by context.
-Do not add objects not visible in original photo, even if implied by context.
-Only modify existing objects;
-never add unseen items, even implied by context.
+never add objects that are not visible in the original photo, even if implied by context.
 Amount of change: a clearly different energetic pose and readable expression;
 preserve identity, belongings and people count.
+Main change that must be clearly visible: The existing person on the left side of the image sits on the chair and looks at the desk.
```

<details><summary>New imagePromptFull (full text)</summary>

```text
Edit the existing single person in image1. Replace the original pose with this action: The existing person on the left side of the image sits on the chair and looks at the desk. Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips; never invent extra hands): "画面左の人物が、椅子に座ったまま机を見る。". Exactly 1 original person remains in the entire image, each appearing once. Original person 1: teal sweatshirt, center front, facing right. Keep this individual in the same center front area and replace only their current pose.    Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main change that must be clearly visible: The existing person on the left side of the image sits on the chair and looks at the desk.
```

</details>

## 1792377988832 scene B (2026-10-19_11-46-28, seed 1457213989)

- Operator instruction: 「画面左の人物が、片手を軽く上げる。」; display text (unchanged): 「30秒後、画面左の人物が、片手を軽く上げる。」
- Actor pose: standing or leaning; occupied hands from holdingFacts: none; screen-side match: no (single person used); presence 0.734177, tone 0.696203
- Action source: translation -> "raises one hand lightly"

Old predictionPrompt:

```text
The existing person on the left side of the image raises one hand lightly.
```

New predictionPrompt:

```text
The existing person on the left side of the image raises one hand lightly.
```

imagePromptFull, sentence-level unified diff (old = archive, new = offline compose):

```diff
--- old (archive, v18)
+++ new (compose, v19)
@@ -17,6 +17,3 @@
 Each person has two arms and two hands.
-Preserve the original head direction and visibility.
-A person viewed from behind remains back-facing with their face hidden;
-a side profile stays a side profile;
-a head cut by the frame remains cut by the frame.
+The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.
 Each held or worn belonging stays with its original owner, with the same shape and size.
@@ -24,11 +21,8 @@
 another person never receives a copy.
-Preserve the original grip during the requested movement.
+A held object stays in the same hand and moves together with that hand during the requested movement;
+never add a hand to free it.
 Only alter existing objects;
-never add new ones not present in original photo.
-Do not introduce objects not visible in original photo.
-Never add objects not visible in original photo, even if implied by context.
-Do not add objects not visible in original photo, even if implied by context.
-Only modify existing objects;
-never add unseen items, even implied by context.
+never add objects that are not visible in the original photo, even if implied by context.
 Amount of change: a clearly different energetic pose and readable expression;
 preserve identity, belongings and people count.
+Main change that must be clearly visible: The existing person on the left side of the image raises one hand lightly.
```

<details><summary>New imagePromptFull (full text)</summary>

```text
Edit the existing single person in image1. Replace the original pose with this action: The existing person on the left side of the image raises one hand lightly. Exactly 1 original person remains in the entire image, each appearing once. Original person 1: teal sweatshirt, center front, facing right. Keep this individual in the same center front area and replace only their current pose.    Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main change that must be clearly visible: The existing person on the left side of the image raises one hand lightly.
```

</details>

## 1792377988832 scene C (2026-10-19_11-46-28, seed 1902310360)

- Operator instruction: 「画面左の人物が、机に片手を置く。」; display text (unchanged): 「30秒前、画面左の人物が、机に片手を置く。」
- Actor pose: standing or leaning; occupied hands from holdingFacts: none; screen-side match: no (single person used); presence 0.734177, tone 0.696203
- Action source: translation -> "places one hand on the desk"

Old predictionPrompt:

```text
The existing person on the left side of the image places one hand on the desk. During the requested action, place an existing hand on the desk for support, only if that hand is originally unoccupied. Preserve every occupied-hand grip; never add a hand to satisfy this contact.
```

New predictionPrompt:

```text
The existing person on the left side of the image places one hand on the desk. Hand use: places one existing hand on the desk; exactly two hands. Never add an extra hand or arm.
```

imagePromptFull, sentence-level unified diff (old = archive, new = offline compose):

```diff
--- old (archive, v18)
+++ new (compose, v19)
@@ -2,5 +2,5 @@
 Replace the original pose with this action: The existing person on the left side of the image places one hand on the desk.
-During the requested action, place an existing hand on the desk for support, only if that hand is originally unoccupied.
-Preserve every occupied-hand grip;
-never add a hand to satisfy this contact.
+Hand use: places one existing hand on the desk;
+exactly two hands.
+Never add an extra hand or arm.
 Exactly 1 original person remains in the entire image, each appearing once.
@@ -20,6 +20,3 @@
 Each person has two arms and two hands.
-Preserve the original head direction and visibility.
-A person viewed from behind remains back-facing with their face hidden;
-a side profile stays a side profile;
-a head cut by the frame remains cut by the frame.
+The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.
 Each held or worn belonging stays with its original owner, with the same shape and size.
@@ -27,11 +24,8 @@
 another person never receives a copy.
-Preserve the original grip during the requested movement.
+A held object stays in the same hand and moves together with that hand during the requested movement;
+never add a hand to free it.
 Only alter existing objects;
-never add new ones not present in original photo.
-Do not introduce objects not visible in original photo.
-Never add objects not visible in original photo, even if implied by context.
-Do not add objects not visible in original photo, even if implied by context.
-Only modify existing objects;
-never add unseen items, even implied by context.
+never add objects that are not visible in the original photo, even if implied by context.
 Amount of change: a clearly different energetic pose and readable expression;
 preserve identity, belongings and people count.
+Main change that must be clearly visible: The existing person on the left side of the image places one hand on the desk.
```

<details><summary>New imagePromptFull (full text)</summary>

```text
Edit the existing single person in image1. Replace the original pose with this action: The existing person on the left side of the image places one hand on the desk. Hand use: places one existing hand on the desk; exactly two hands. Never add an extra hand or arm. Exactly 1 original person remains in the entire image, each appearing once. Original person 1: teal sweatshirt, center front, facing right. Keep this individual in the same center front area and replace only their current pose.    Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main change that must be clearly visible: The existing person on the left side of the image places one hand on the desk.
```

</details>

## 1792379506138 scene A (2026-10-19_12-11-46, seed 1375388456)

- Operator instruction: 「画面左の人物が、椅子に座ったまま机を見る。」; display text (unchanged): 「15秒後、画面左の人物が、椅子に座ったまま机を見る。」
- Actor pose: seated; occupied hands from holdingFacts: ['right']; screen-side match: no (single person used); presence 0.734177, tone 0.696203
- Action source: translation -> "stays seated on the chair and looks down at the desk"

Old predictionPrompt:

```text
The existing person on the left side of the image sits down. Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips; never invent extra hands): "画面左の人物が、椅子に座ったまま机を見る。".
```

New predictionPrompt:

```text
The existing person on the left side of the image stays seated on the chair and looks down at the desk. Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips; never invent extra hands): "画面左の人物が、椅子に座ったまま机を見る。".
```

imagePromptFull, sentence-level unified diff (old = archive, new = offline compose):

```diff
--- old (archive, v18)
+++ new (compose, v19)
@@ -1,3 +1,3 @@
 Edit the existing single person in image1.
-Replace the original pose with this action: The existing person on the left side of the image sits down.
+Replace the original pose with this action: The existing person on the left side of the image stays seated on the chair and looks down at the desk.
 Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips;
@@ -9,3 +9,4 @@
 Keep this individual in the same right front area and replace only their current pose.
-Keep white cup in right hand with this owner, in the occupied hand.
+Keep white cup in right hand with this owner, in the same hand;
+the item moves together with that hand.
 Image2/image3 are identity references for the SAME original people, showing face/hair only.
@@ -22,6 +23,3 @@
 Each person has two arms and two hands.
-Preserve the original head direction and visibility.
-A person viewed from behind remains back-facing with their face hidden;
-a side profile stays a side profile;
-a head cut by the frame remains cut by the frame.
+The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.
 Each held or worn belonging stays with its original owner, with the same shape and size.
@@ -29,11 +27,8 @@
 another person never receives a copy.
-Preserve the original grip during the requested movement.
+A held object stays in the same hand and moves together with that hand during the requested movement;
+never add a hand to free it.
 Only alter existing objects;
-never add new ones not present in original photo.
-Do not introduce objects not visible in original photo.
-Never add objects not visible in original photo, even if implied by context.
-Do not add objects not visible in original photo, even if implied by context.
-Only modify existing objects;
-never add unseen items, even implied by context.
+never add objects that are not visible in the original photo, even if implied by context.
 Amount of change: a clearly different energetic pose and readable expression;
 preserve identity, belongings and people count.
+Main change that must be clearly visible: The existing person on the left side of the image stays seated on the chair and looks down at the desk.
```

<details><summary>New imagePromptFull (full text)</summary>

```text
Edit the existing single person in image1. Replace the original pose with this action: The existing person on the left side of the image stays seated on the chair and looks down at the desk. Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips; never invent extra hands): "画面左の人物が、椅子に座ったまま机を見る。". The blue long-sleeved top person continuously keeps white cup in right hand, with the original hand grip. All their worn or hanging items stay attached and visible. Exactly 1 original person remains in the entire image, each appearing once. Original person 1: blue long-sleeved top, right front, facing right. Keep this individual in the same right front area and replace only their current pose. Keep white cup in right hand with this owner, in the same hand; the item moves together with that hand.   Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main change that must be clearly visible: The existing person on the left side of the image stays seated on the chair and looks down at the desk.
```

</details>

## 1792379506138 scene B (2026-10-19_12-11-46, seed 344204550)

- Operator instruction: 「画面左の人物が、片手を軽く上げる。」; display text (unchanged): 「30秒後、画面左の人物が、片手を軽く上げる。」
- Actor pose: seated; occupied hands from holdingFacts: ['right']; screen-side match: no (single person used); presence 0.734177, tone 0.696203
- Action source: translation -> "raises one hand lightly"

Old predictionPrompt:

```text
The existing person on the left side of the image raises one hand lightly.
```

New predictionPrompt:

```text
The existing person on the left side of the image raises one hand lightly. Hand use: raises one existing hand lightly; if it holds an object, the object rises together with that same hand; the other hand stays where it is; exactly two hands. Never add an extra hand or arm.
```

imagePromptFull, sentence-level unified diff (old = archive, new = offline compose):

```diff
--- old (archive, v18)
+++ new (compose, v19)
@@ -2,2 +2,7 @@
 Replace the original pose with this action: The existing person on the left side of the image raises one hand lightly.
+Hand use: raises one existing hand lightly;
+if it holds an object, the object rises together with that same hand;
+the other hand stays where it is;
+exactly two hands.
+Never add an extra hand or arm.
 The blue long-sleeved top person continuously keeps white cup in right hand, with the original hand grip.
@@ -7,3 +12,4 @@
 Keep this individual in the same right front area and replace only their current pose.
-Keep white cup in right hand with this owner, in the occupied hand.
+Keep white cup in right hand with this owner, in the same hand;
+the item moves together with that hand.
 Image2/image3 are identity references for the SAME original people, showing face/hair only.
@@ -20,6 +26,3 @@
 Each person has two arms and two hands.
-Preserve the original head direction and visibility.
-A person viewed from behind remains back-facing with their face hidden;
-a side profile stays a side profile;
-a head cut by the frame remains cut by the frame.
+The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.
 Each held or worn belonging stays with its original owner, with the same shape and size.
@@ -27,11 +30,8 @@
 another person never receives a copy.
-Preserve the original grip during the requested movement.
+A held object stays in the same hand and moves together with that hand during the requested movement;
+never add a hand to free it.
 Only alter existing objects;
-never add new ones not present in original photo.
-Do not introduce objects not visible in original photo.
-Never add objects not visible in original photo, even if implied by context.
-Do not add objects not visible in original photo, even if implied by context.
-Only modify existing objects;
-never add unseen items, even implied by context.
+never add objects that are not visible in the original photo, even if implied by context.
 Amount of change: a clearly different energetic pose and readable expression;
 preserve identity, belongings and people count.
+Main change that must be clearly visible: The existing person on the left side of the image raises one hand lightly.
```

<details><summary>New imagePromptFull (full text)</summary>

```text
Edit the existing single person in image1. Replace the original pose with this action: The existing person on the left side of the image raises one hand lightly. Hand use: raises one existing hand lightly; if it holds an object, the object rises together with that same hand; the other hand stays where it is; exactly two hands. Never add an extra hand or arm. The blue long-sleeved top person continuously keeps white cup in right hand, with the original hand grip. All their worn or hanging items stay attached and visible. Exactly 1 original person remains in the entire image, each appearing once. Original person 1: blue long-sleeved top, right front, facing right. Keep this individual in the same right front area and replace only their current pose. Keep white cup in right hand with this owner, in the same hand; the item moves together with that hand.   Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main change that must be clearly visible: The existing person on the left side of the image raises one hand lightly.
```

</details>

## 1792379506138 scene C (2026-10-19_12-11-46, seed 2006410853)

- Operator instruction: 「画面左の人物が、机に片手を置く。」; display text (unchanged): 「30秒前、画面左の人物が、机に片手を置く。」
- Actor pose: seated; occupied hands from holdingFacts: ['right']; screen-side match: no (single person used); presence 0.734177, tone 0.696203
- Action source: translation -> "places one hand on the desk"

Old predictionPrompt:

```text
The existing person on the left side of the image places one hand on the desk. During the requested action, place an existing hand on the desk for support, only if that hand is originally unoccupied. Preserve every occupied-hand grip; never add a hand to satisfy this contact.
```

New predictionPrompt:

```text
The existing person on the left side of the image places one hand on the desk. Hand use: places the free left hand on the desk; the right hand keeps holding its object; exactly two hands. Never add an extra hand or arm.
```

imagePromptFull, sentence-level unified diff (old = archive, new = offline compose):

```diff
--- old (archive, v18)
+++ new (compose, v19)
@@ -2,5 +2,6 @@
 Replace the original pose with this action: The existing person on the left side of the image places one hand on the desk.
-During the requested action, place an existing hand on the desk for support, only if that hand is originally unoccupied.
-Preserve every occupied-hand grip;
-never add a hand to satisfy this contact.
+Hand use: places the free left hand on the desk;
+the right hand keeps holding its object;
+exactly two hands.
+Never add an extra hand or arm.
 The blue long-sleeved top person continuously keeps white cup in right hand, with the original hand grip.
@@ -10,3 +11,4 @@
 Keep this individual in the same right front area and replace only their current pose.
-Keep white cup in right hand with this owner, in the occupied hand.
+Keep white cup in right hand with this owner, in the same hand;
+the item moves together with that hand.
 Image2/image3 are identity references for the SAME original people, showing face/hair only.
@@ -23,6 +25,3 @@
 Each person has two arms and two hands.
-Preserve the original head direction and visibility.
-A person viewed from behind remains back-facing with their face hidden;
-a side profile stays a side profile;
-a head cut by the frame remains cut by the frame.
+The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.
 Each held or worn belonging stays with its original owner, with the same shape and size.
@@ -30,11 +29,8 @@
 another person never receives a copy.
-Preserve the original grip during the requested movement.
+A held object stays in the same hand and moves together with that hand during the requested movement;
+never add a hand to free it.
 Only alter existing objects;
-never add new ones not present in original photo.
-Do not introduce objects not visible in original photo.
-Never add objects not visible in original photo, even if implied by context.
-Do not add objects not visible in original photo, even if implied by context.
-Only modify existing objects;
-never add unseen items, even implied by context.
+never add objects that are not visible in the original photo, even if implied by context.
 Amount of change: a clearly different energetic pose and readable expression;
 preserve identity, belongings and people count.
+Main change that must be clearly visible: The existing person on the left side of the image places one hand on the desk.
```

<details><summary>New imagePromptFull (full text)</summary>

```text
Edit the existing single person in image1. Replace the original pose with this action: The existing person on the left side of the image places one hand on the desk. Hand use: places the free left hand on the desk; the right hand keeps holding its object; exactly two hands. Never add an extra hand or arm. The blue long-sleeved top person continuously keeps white cup in right hand, with the original hand grip. All their worn or hanging items stay attached and visible. Exactly 1 original person remains in the entire image, each appearing once. Original person 1: blue long-sleeved top, right front, facing right. Keep this individual in the same right front area and replace only their current pose. Keep white cup in right hand with this owner, in the same hand; the item moves together with that hand.   Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main change that must be clearly visible: The existing person on the left side of the image places one hand on the desk.
```

</details>

## 1792379927523 scene A (2026-10-19_12-18-47, seed 362854788)

- Operator instruction: 「画面左の人物が、椅子に座ったまま机を見る。」; display text (unchanged): 「15秒後、画面左の人物が、椅子に座ったまま机を見る。」
- Actor pose: standing; occupied hands from holdingFacts: none; screen-side match: yes; presence 0.734177, tone 0.696203
- Action source: translation -> "sits on the chair and looks at the desk"

Old predictionPrompt:

```text
The existing person on the left side of the image wearing teal long-sleeved shirt sits down. Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips; never invent extra hands): "画面左の人物が、椅子に座ったまま机を見る。".
```

New predictionPrompt:

```text
The existing person on the left side of the image wearing teal long-sleeved shirt sits on the chair and looks at the desk. Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips; never invent extra hands): "画面左の人物が、椅子に座ったまま机を見る。".
```

imagePromptFull, sentence-level unified diff (old = archive, new = offline compose):

```diff
--- old (archive, v18)
+++ new (compose, v19)
@@ -1,3 +1,3 @@
 Edit the existing single person in image1.
-Replace the original pose with this action: The existing person on the left side of the image wearing teal long-sleeved shirt sits down.
+Replace the original pose with this action: The existing person on the left side of the image wearing teal long-sleeved shirt sits on the chair and looks at the desk.
 Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips;
@@ -21,6 +21,3 @@
 Each person has two arms and two hands.
-Preserve the original head direction and visibility.
-A person viewed from behind remains back-facing with their face hidden;
-a side profile stays a side profile;
-a head cut by the frame remains cut by the frame.
+The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.
 Each held or worn belonging stays with its original owner, with the same shape and size.
@@ -28,11 +25,8 @@
 another person never receives a copy.
-Preserve the original grip during the requested movement.
+A held object stays in the same hand and moves together with that hand during the requested movement;
+never add a hand to free it.
 Only alter existing objects;
-never add new ones not present in original photo.
-Do not introduce objects not visible in original photo.
-Never add objects not visible in original photo, even if implied by context.
-Do not add objects not visible in original photo, even if implied by context.
-Only modify existing objects;
-never add unseen items, even implied by context.
+never add objects that are not visible in the original photo, even if implied by context.
 Amount of change: a clearly different energetic pose and readable expression;
 preserve identity, belongings and people count.
+Main change that must be clearly visible: The existing person on the left side of the image wearing teal long-sleeved shirt sits on the chair and looks at the desk.
```

<details><summary>New imagePromptFull (full text)</summary>

```text
Edit the existing single person in image1. Replace the original pose with this action: The existing person on the left side of the image wearing teal long-sleeved shirt sits on the chair and looks at the desk. Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips; never invent extra hands): "画面左の人物が、椅子に座ったまま机を見る。". Exactly 1 original person remains in the entire image, each appearing once. Original person 1: teal long-sleeved shirt, left front, facing away. Keep this individual in the same left front area and replace only their current pose.  Keep black wristband attached. Their back remains toward the camera, with their face hidden. Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main change that must be clearly visible: The existing person on the left side of the image wearing teal long-sleeved shirt sits on the chair and looks at the desk.
```

</details>

## 1792379927523 scene B (2026-10-19_12-18-47, seed 753128258)

- Operator instruction: 「画面左の人物が、片手を軽く上げる。」; display text (unchanged): 「30秒後、画面左の人物が、片手を軽く上げる。」
- Actor pose: standing; occupied hands from holdingFacts: none; screen-side match: yes; presence 0.734177, tone 0.696203
- Action source: translation -> "raises one hand lightly"

Old predictionPrompt:

```text
The existing person on the left side of the image wearing teal long-sleeved shirt raises one hand lightly.
```

New predictionPrompt:

```text
The existing person on the left side of the image wearing teal long-sleeved shirt raises one hand lightly.
```

imagePromptFull, sentence-level unified diff (old = archive, new = offline compose):

```diff
--- old (archive, v18)
+++ new (compose, v19)
@@ -19,6 +19,3 @@
 Each person has two arms and two hands.
-Preserve the original head direction and visibility.
-A person viewed from behind remains back-facing with their face hidden;
-a side profile stays a side profile;
-a head cut by the frame remains cut by the frame.
+The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.
 Each held or worn belonging stays with its original owner, with the same shape and size.
@@ -26,11 +23,8 @@
 another person never receives a copy.
-Preserve the original grip during the requested movement.
+A held object stays in the same hand and moves together with that hand during the requested movement;
+never add a hand to free it.
 Only alter existing objects;
-never add new ones not present in original photo.
-Do not introduce objects not visible in original photo.
-Never add objects not visible in original photo, even if implied by context.
-Do not add objects not visible in original photo, even if implied by context.
-Only modify existing objects;
-never add unseen items, even implied by context.
+never add objects that are not visible in the original photo, even if implied by context.
 Amount of change: a clearly different energetic pose and readable expression;
 preserve identity, belongings and people count.
+Main change that must be clearly visible: The existing person on the left side of the image wearing teal long-sleeved shirt raises one hand lightly.
```

<details><summary>New imagePromptFull (full text)</summary>

```text
Edit the existing single person in image1. Replace the original pose with this action: The existing person on the left side of the image wearing teal long-sleeved shirt raises one hand lightly. Exactly 1 original person remains in the entire image, each appearing once. Original person 1: teal long-sleeved shirt, left front, facing away. Keep this individual in the same left front area and replace only their current pose.  Keep black wristband attached. Their back remains toward the camera, with their face hidden. Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main change that must be clearly visible: The existing person on the left side of the image wearing teal long-sleeved shirt raises one hand lightly.
```

</details>

## 1792379927523 scene C (2026-10-19_12-18-47, seed 979547398)

- Operator instruction: 「画面左の人物が、机に片手を置く。」; display text (unchanged): 「30秒前、画面左の人物が、机に片手を置く。」
- Actor pose: standing; occupied hands from holdingFacts: none; screen-side match: yes; presence 0.734177, tone 0.696203
- Action source: translation -> "places one hand on the desk"

Old predictionPrompt:

```text
The existing person on the left side of the image wearing teal long-sleeved shirt places one hand on the desk. During the requested action, place an existing hand on the desk for support, only if that hand is originally unoccupied. Preserve every occupied-hand grip; never add a hand to satisfy this contact.
```

New predictionPrompt:

```text
The existing person on the left side of the image wearing teal long-sleeved shirt places one hand on the desk. Hand use: places one existing hand on the desk; exactly two hands. Never add an extra hand or arm.
```

imagePromptFull, sentence-level unified diff (old = archive, new = offline compose):

```diff
--- old (archive, v18)
+++ new (compose, v19)
@@ -2,5 +2,5 @@
 Replace the original pose with this action: The existing person on the left side of the image wearing teal long-sleeved shirt places one hand on the desk.
-During the requested action, place an existing hand on the desk for support, only if that hand is originally unoccupied.
-Preserve every occupied-hand grip;
-never add a hand to satisfy this contact.
+Hand use: places one existing hand on the desk;
+exactly two hands.
+Never add an extra hand or arm.
 Exactly 1 original person remains in the entire image, each appearing once.
@@ -22,6 +22,3 @@
 Each person has two arms and two hands.
-Preserve the original head direction and visibility.
-A person viewed from behind remains back-facing with their face hidden;
-a side profile stays a side profile;
-a head cut by the frame remains cut by the frame.
+The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.
 Each held or worn belonging stays with its original owner, with the same shape and size.
@@ -29,11 +26,8 @@
 another person never receives a copy.
-Preserve the original grip during the requested movement.
+A held object stays in the same hand and moves together with that hand during the requested movement;
+never add a hand to free it.
 Only alter existing objects;
-never add new ones not present in original photo.
-Do not introduce objects not visible in original photo.
-Never add objects not visible in original photo, even if implied by context.
-Do not add objects not visible in original photo, even if implied by context.
-Only modify existing objects;
-never add unseen items, even implied by context.
+never add objects that are not visible in the original photo, even if implied by context.
 Amount of change: a clearly different energetic pose and readable expression;
 preserve identity, belongings and people count.
+Main change that must be clearly visible: The existing person on the left side of the image wearing teal long-sleeved shirt places one hand on the desk.
```

<details><summary>New imagePromptFull (full text)</summary>

```text
Edit the existing single person in image1. Replace the original pose with this action: The existing person on the left side of the image wearing teal long-sleeved shirt places one hand on the desk. Hand use: places one existing hand on the desk; exactly two hands. Never add an extra hand or arm. Exactly 1 original person remains in the entire image, each appearing once. Original person 1: teal long-sleeved shirt, left front, facing away. Keep this individual in the same left front area and replace only their current pose.  Keep black wristband attached. Their back remains toward the camera, with their face hidden. Image2/image3 are identity references for the SAME original people, showing face/hair only. Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit. Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.

The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.

Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.

Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.

Amount of change: a clearly different energetic pose and readable expression; preserve identity, belongings and people count.

Main change that must be clearly visible: The existing person on the left side of the image wearing teal long-sleeved shirt places one hand on the desk.
```

</details>

