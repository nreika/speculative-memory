# Empty-room prompt diff, 2026-10-19

Offline re-composition from archived inputs (`speculative-memory_data/generations/2026-10-19/<ts>/<ts>_prompts.json`: guard.scene, raw VLM `foreground_object`, scene `predictionPrompt`, `distanceSec`). No model was called. The old and new image prompts are both built with `composeEditInstruction({presence: 0, distanceSec, foregroundObject})` from the current checkout, so only the action sentence differs. The `-`/`+` lines show the first 160 characters of the image prompt.

## Where the no-change sentence came from

The planner (VLM) did not write it. In empty rooms the 4B planner usually describes a person who is not there ("The person seated in the black office chair leans forward…"). `findFabricatedScenarios` flags those scenes, empty rooms get only one planner call, and `applySafeFallback` → `safeScenario` (scenarioGuard.ts) replaced each one with the template `` `The ${obj} remains exactly as in the input.` ``, where `obj` is the scene-description noun at that index (workshop / pipes / fluorescent lights). Weak planner answers ("remains stationary") went to `synthesizeEmptyRoom` (peopleDescribe.ts), which uses the same template. If the object was "fluorescent lighting", `withoutLightingChanges` in `finishWith` (vlmClient.ts) then removed the whole sentence and the fallback became "Keep the scene exactly as in the input." The display text is a translation of that English sentence.

In the last 41 empty batches this happened to 104 of 123 scenes through the person-invented path, 5 through the weak-answer path and 2 through the duplicate path.

## Change (this checkout, server not restarted)

- `scenarioGuard.ts`: new `movableObjects` and `emptyRoomObjectChange`. The second picks one movable object from the frame description: seats (chair, stool) first, then containers (bin, box, crate…), then bags. It never picks the near-camera `foreground_object`, which the foreground rule pins in place; when the foreground object is one of several of its kind, it uses "one of the … further from the camera". It also skips parts of objects, items on shelves and bags hanging from something. The sentence is one small turn or shift, scaled by |distance|: under 60 s "a few degrees / centimetres", under 300 s "about fifteen degrees / ten centimetres", otherwise "about thirty degrees / twenty centimetres". It contains no lighting, screen or person words. `safeScenario` and `applySafeFallback` take the scene distances and use it.
- `peopleDescribe.ts`: `synthesizeEmptyRoom` takes optional `scene` and `foregroundObject` and uses the same change.
- `vlmClient.ts` `finishWith`: in an empty room (no detector person, no recent person), a sentence that is empty after the lighting filter, or that is a no-change sentence (`isNoChangeSentence`), becomes the object change. This one step covers every path, so the image prompt and the Japanese display text both get the change.
- If the frame has no movable object outside the foreground, the old text stays. That scene is a skip candidate (see the report). Across all of today's empty batches this applies to 30 of 238 batches (13%).

Re-run over every empty batch of 2026-10-19: the action sentence changes in 576 of 713 scenes, and 94 scenes still say no change (all in the no-movable-object batches).

## 2026-10-19_14-09-13

- scene_description: An industrial-style workshop with exposed ductwork, fluorescent lighting, and translucent curtains dividing workspaces. A large green plastic storage bin is prominent in the foreground, next to a black office chair with a beige tote bag hanging from its backrest. Behind, shelves hold various boxes and containers, with a metal-framed workbench visible. The camera angle is fixed, capturing the cluttered, functional space with no visible people.
- foreground_object: the top of a large green plastic storage bin, about 45 cm wide, positioned directly in front of the camera
- movable objects (foreground excluded): black office chair

### Scene A (+15s)

- raw VLM: The person seated in the black office chair leans forward slightly, resting their hands on the desk, while the beige tote bag remains hanging from the chair's backrest.
- archived display (ja): 15秒後、工業風のワークショップは入力の状態とまったく同じです。

```diff
- Edit this exact photo according to: The industrial-style workshop remains exactly as in the input. Keep the architecture, camera, framing, exposure, lighting co
+ Edit this exact photo according to: The black office chair is turned a few degrees to the right. Keep the architecture, camera, framing, exposure, lighting colo
```
- rest of the image prompt identical: true
- new display: the English scene sentence "The black office chair is turned a few degrees to the right." goes through the existing Japanese translation step at runtime (not run offline).

### Scene B (+30s)

- raw VLM: The person seated in the black office chair shifts their weight slightly, turning their head to the right, while the beige tote bag remains hanging from the chair's backrest.
- archived display (ja): 30秒後、露出された配管は入力の状態とまったく同じです。

```diff
- Edit this exact photo according to: The exposed ductwork remains exactly as in the input. Keep the architecture, camera, framing, exposure, lighting colour, whi
+ Edit this exact photo according to: The black office chair is turned a few degrees to the left. Keep the architecture, camera, framing, exposure, lighting colou
```
- rest of the image prompt identical: true
- new display: the English scene sentence "The black office chair is turned a few degrees to the left." goes through the existing Japanese translation step at runtime (not run offline).

### Scene C (-30s)

- raw VLM: The person seated in the black office chair leans back slightly, adjusting their posture, while the beige tote bag remains hanging from the chair's backrest.
- archived display (ja): 30秒前、シーンを入力の状態とまったく同じに保ちます。

```diff
- Edit this exact photo according to: Keep the scene exactly as in the input. Keep the architecture, camera, framing, exposure, lighting colour, white balance, sh
+ Edit this exact photo according to: The black office chair sits a few centimetres further to the right. Keep the architecture, camera, framing, exposure, lighti
```
- rest of the image prompt identical: true
- new display: the English scene sentence "The black office chair sits a few centimetres further to the right." goes through the existing Japanese translation step at runtime (not run offline).

## 2026-10-19_14-08-21

- scene_description: An industrial workshop with exposed pipes, fluorescent lights, and gray plastic curtains dividing workspaces. A large green plastic storage container is in the foreground, and a black office chair is partially visible to its left.
- foreground_object: the back of a black office chair, about 50 cm wide, positioned at the edge of the frame
- movable objects (foreground excluded): green plastic storage container

### Scene A (+15s)

- raw VLM: The person in the black chair shifts slightly forward, adjusting their posture, and their right hand moves toward the desk surface.
- archived display (ja): 15秒後、工業用工場は入力の状態に完全に変わらない。

```diff
- Edit this exact photo according to: The industrial workshop remains exactly as in the input. Keep the architecture, camera, framing, exposure, lighting colour, 
+ Edit this exact photo according to: The green plastic storage container sits a few centimetres further to the right. Keep the architecture, camera, framing, exp
```
- rest of the image prompt identical: true
- new display: the English scene sentence "The green plastic storage container sits a few centimetres further to the right." goes through the existing Japanese translation step at runtime (not run offline).

### Scene B (+30s)

- raw VLM: The person in the black chair sits up fully, turns their head to the right, and raises both hands to rest on the chair's backrest.
- archived display (ja): 30秒後、露出されたパイプは入力の状態に完全に変わらない。

```diff
- Edit this exact photo according to: The exposed pipes remains exactly as in the input. Keep the architecture, camera, framing, exposure, lighting colour, white 
+ Edit this exact photo according to: The green plastic storage container sits a few centimetres further to the left. Keep the architecture, camera, framing, expo
```
- rest of the image prompt identical: true
- new display: the English scene sentence "The green plastic storage container sits a few centimetres further to the left." goes through the existing Japanese translation step at runtime (not run offline).

### Scene C (-30s)

- raw VLM: The person in the black chair leans back slightly, lowers their head, and places both hands on their lap.
- archived display (ja): 30秒前、蛍光灯は入力の状態に完全に変わらない。

```diff
- Edit this exact photo according to: The fluorescent lights remains exactly as in the input. Keep the architecture, camera, framing, exposure, lighting colour, w
+ Edit this exact photo according to: The green plastic storage container is turned a few degrees to the right. Keep the architecture, camera, framing, exposure, 
```
- rest of the image prompt identical: true
- new display: the English scene sentence "The green plastic storage container is turned a few degrees to the right." goes through the existing Japanese translation step at runtime (not run offline).

## 2026-10-19_13-52-13

- scene_description: An empty warehouse-like space with exposed pipes, fluorescent lights, and clear plastic curtains separating workstations. A large green plastic storage bin is in the foreground.
- foreground_object: (none)
- movable objects (foreground excluded): green plastic storage bin

### Scene A (+15s)

- raw VLM: The storage bin remains stationary with no changes to its position or appearance.
- archived display (ja): 15秒後、倉庫のような空間は入力の通り完全に変わらない。

```diff
- Edit this exact photo according to: The warehouse-like space remains exactly as in the input. Keep the architecture, camera, framing, exposure, lighting colour,
+ Edit this exact photo according to: The green plastic storage bin sits a few centimetres further to the right. Keep the architecture, camera, framing, exposure,
```
- rest of the image prompt identical: true
- new display: the English scene sentence "The green plastic storage bin sits a few centimetres further to the right." goes through the existing Japanese translation step at runtime (not run offline).

### Scene B (+30s)

- raw VLM: The bin remains stationary with no changes to its position or appearance.
- archived display (ja): 30秒後、露出されたパイプは入力の通り完全に変わらない。

```diff
- Edit this exact photo according to: The exposed pipes remains exactly as in the input. Keep the architecture, camera, framing, exposure, lighting colour, white 
+ Edit this exact photo according to: The green plastic storage bin sits a few centimetres further to the left. Keep the architecture, camera, framing, exposure, 
```
- rest of the image prompt identical: true
- new display: the English scene sentence "The green plastic storage bin sits a few centimetres further to the left." goes through the existing Japanese translation step at runtime (not run offline).

### Scene C (-30s)

- raw VLM: The bin remains stationary with no changes to its position or appearance.
- archived display (ja): 30秒前、蛍光灯は入力の通り完全に変わらない。

```diff
- Edit this exact photo according to: The fluorescent lights remains exactly as in the input. Keep the architecture, camera, framing, exposure, lighting colour, w
+ Edit this exact photo according to: The green plastic storage bin is turned a few degrees to the right. Keep the architecture, camera, framing, exposure, lighti
```
- rest of the image prompt identical: true
- new display: the English scene sentence "The green plastic storage bin is turned a few degrees to the right." goes through the existing Japanese translation step at runtime (not run offline).

Scenes: 9, action sentence changed: 9
