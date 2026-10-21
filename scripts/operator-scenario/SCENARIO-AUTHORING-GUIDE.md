# Speculative Memory: Scenario CSV Authoring Guide

Version 1.1 · 2026-10-21

> 日本語の概要: このファイルは、任意のPC上の任意のAIが「シナリオCSV」を会話だけで（バイブコーディングで）正しく書くための唯一のガイドです。AIにこのファイルを読ませ、末尾の「システムプロンプト」を貼り、作りたい場面を日本語で話してください。AIは検証コマンドでCSVを自己チェックします。CSVの正否は常に `scripts/operator-scenario/scenario_csv.py` のチェッカーが決めます（例CSVや本書より優先）。

Authoritative source: the checker `scripts/operator-scenario/scenario_csv.py` (run via `parse_plan.py`). If this guide, an example file, or any other document disagrees with the checker, the checker wins. Verified against the code on 2026-10-21.

## 1. What the system does (システムの概要)

1. A camera takes a NOW photo of the room. The server generates three images from it: A and B at a time distance in the future, C at a distance in the past (defaults: A +30 s, B +30 s, C -30 s; signed seconds, negative = past).
2. The images are shown on browser screens named `screen-1` .. `screen-10` (each screen can show now, a, b, c, ...).
3. **Tone** (0..1) = size of an everyday movement in the generated scene (small natural movement .. big but ordinary). **Presence** (0..1) = how present the person is: 0 = empty room, low = small and far (edge/background), 1 = centre of attention; on an empty photo it also sets whether a recently seen person appears. Both are plain numbers; see section 5.
4. Captions on screens are Japanese. They come from the text planned for each scene, which you steer with the `instructions` / `prompt` / `one_shot` rows.
5. A scenario CSV is a timeline of cues (one row = one cue) that changes prompts, settings, screen mapping and triggers generation, then ends (or loops).

## 2. CSV contract (CSVの規約)

Header line, exactly (the first four are required; the last six are optional and only used by `image` rows):

```
seconds,action,target,value
```
Optional extra columns, from this set only: `source_rect,target_rect,fit,opacity,feather_px,instruction`. Any other column name is an error; duplicate or missing required columns are errors. Normal scenarios use only the first four columns.

- Encoding UTF-8 (BOM tolerated). File at most 2 MB. At most 1000 cue rows. Blank rows are ignored.
- One row per cue. Every row has exactly as many fields as the header.
- `seconds`: number 0..86400 (decimals ok). Cues run in time order; a row earlier than the previous one only gives a warning (rows are sorted, stable), but keep the file in ascending order.
- Meta rows `scenario`, `instructions`, `loop` (and `end`) may appear at most once each. `scenario`, `instructions`, `loop` must be at second 0 with a blank `target`.
- `end` row: `N,end,,` where N (> 0) is the scenario duration in seconds; no value, no target. Every cue must be at or before N (strictly before N when `loop` is true). Without an `end` row you only get a warning and the duration becomes the last cue time (min 1 s), but `loop,,true` then REQUIRES an `end` row. Always write an `end` row.
- Quoting: standard CSV. A value containing an ASCII comma `,`, a double quote, or a line break must be wrapped in double quotes; a double quote inside is written `""`. The Japanese comma `、` and period `。` are ordinary characters and need no quoting, but quoting every Japanese text value is the safe habit.
- Row numbers in messages are 1-based CSV lines (header = 1).
- Fields are trimmed of leading/trailing spaces. A scene prompt is at most 8000 characters.
- Ignored: completely blank rows. `note` rows do nothing at runtime (comments). Unused optional columns only give a warning.
- Errors prevent loading (nothing is loaded). Warnings load but should be fixed.

## 3. Command table (コマンド表)

`target`/`value` must be blank where noted. Scenes are `A`, `B`, `C` (upper-case). Screens are `screen-N` (N = 1..999 syntactically; if the screen does not exist in the current browser outputs you only get a warning "target screen-N does not exist"). `true`/`false` are lower-case.

Tags: **TRIGGERS** = starts a generation. **LIVE** = only takes effect in Live play and is skipped in Preview only (section 4). Rows without LIVE (output_* rows, prompts) also work in Preview.

| action | target | value | meaning / constraints | example |
|---|---|---|---|---|
| `scenario` | blank | ID, 1-128 chars of `A-Z a-z 0-9 _ . : -` | Scenario ID (meta, second 0, once). If absent the ID is the file name. | `0,scenario,,EX-1` |
| `instructions` | blank | free text | Note for the operator/participants (meta, second 0, once). Not a generation prompt. | `0,instructions,,"Calm room, 3 min"` |
| `loop` | blank | `true` or `false` | Repeat the timeline. True needs an `end` row; cues must be before `end`. Prompts/images reset each cycle. | `0,loop,,true` |
| `end` | blank | blank | Duration N in `seconds`. | `180,end,,` |
| `note` | blank | text | Comment, no effect (warning if the same text appears twice). | `50,note,,"set 1 visible"` |
| `generate` | blank | blank | One generation of A/B/C from the current NOW photo. **TRIGGERS**, LIVE. Skipped in Preview; also skipped as "late" if it is not the last generate in its batch or is more than 2 s late. | `5,generate,,` |
| `prompt` | A/B/C | text (not empty) | Persistent instruction for that scene until cleared or replaced. Write it in Japanese; captions derive from it. | `2,prompt,A,"人が姿勢を直す。"` |
| `one_shot` | A/B/C | text (not empty) | Instruction for the next generation only, then consumed. | `95,one_shot,A,"人が窓を見る。"` |
| `clear_prompt` | A/B/C | blank | Empties that scene's persistent prompt. | `130,clear_prompt,A,` |
| `scene_mode` | A/B/C | `asset_only`, `people_and_assets`, `default` | How a scene uses image elements. `asset_only` requires an active `image` element for that scene. Advanced. | `0,scene_mode,A,default` |
| `image` | A/B/C | PNG file name relative to the CSV folder | Overlay a PNG on a scene. Advanced: PNG must be in the same folder (.png only; no `\`, no `:`, no absolute path; <= 8 MB each, 24 MB total; <= 8 elements per scene). Optional columns (blank = default): `source_rect`, `target_rect` as `x\|y\|w\|h` in 0..1 inside the image (default `0\|0\|1\|1`); `fit` cover or contain (default cover); `opacity` 0..1 (default 1); `feather_px` integer 0..256 (default 24); `instruction` text <= 2000. Image columns on non-image rows are an error. | `10,image,A,logo.png` |
| `clear_image` | A/B/C | blank | Remove that scene's image elements. | `20,clear_image,A,` |
| `mode` | blank | `manual`, `timer`, `chain` | Capture mode. manual: only `generate` rows generate. timer: automatic capture every `interval_sec`. chain: next capture 1 s after the previous one. LIVE. | `0,mode,,chain` |
| `interval_sec` | blank | number 5..3600 | Timer interval. LIVE. | `0,interval_sec,,90` |
| `distance` | A/B/C | seconds -3600..3600 | Signed time distance; positive = future, negative = past. LIVE. | `0,distance,C,-30` |
| `tone` | blank = all scenes; A/B/C = that scene | 0..1 | Size of the everyday movement. LIVE. | `0,tone,B,0.3` |
| `presence` | blank or A/B/C | 0..1 | How present the person is (0 empty room .. 1 centre of attention). LIVE. | `0,presence,,0.5` |
| `empty_person` | blank | 0..1 | Chance of a person appearing in an EMPTY room (default 0.3). LIVE. | `0,empty_person,,0` |
| `person_refs` | A/B/C | up to 15 UUIDs joined by `\|`, or blank to clear | Persistent person reference IDs for that scene (UUIDs of recently captured people; ask the operator). LIVE. Rarely used. | |
| `person_refs_once` | A/B/C | same | Same, next generation only. LIVE. | |
| `pause` | blank | blank | Pause new generation requests (hold). LIVE. | `12,pause,,` |
| `resume` | blank | blank | Enable generation (release the hold). LIVE. Put `0,resume,,` first if the run must generate. | `0,resume,,` |
| `layout` | blank | 4 names joined by `\|`, each of A, B, C, NOW exactly once | Legacy DISPLAY 1..4 order. Prefer `output_source`. | `0,layout,,NOW\|A\|B\|C` |
| `output_source` | screen-N | `now a b c actual-past generated-history fixed td-1 td-2 td-3 td-4` | What a screen shows. | `0,output_source,screen-1,a` |
| `output_image` | screen-N | content ID (<= 256 chars) | Fixed content (also sets source=fixed). Advanced. | |
| `output_sequence` | screen-N | `folder\|frame_sec\|start\|end` (folder under `speculative-memory_data/sequences/`; frame_sec 1..86400, default 30; start/end 1..2000, blank end = last frame) | Plays a fixed image sequence (PNG/JPEG, natural filename order), looping; also sets source=fixed-sequence. | `0,output_sequence,screen-10,demo\|5\|2\|4` |
| `output_scene` | screen-N | `a b c any` | Scene filter of a screen. Advanced. | |
| `output_delay_sec` | screen-N | 0..86400 | Display delay of a screen. | `0,output_delay_sec,screen-2,10` |
| `output_visible` | screen-N | `true` / `false` | Show or hide a screen. | `10,output_visible,screen-2,false` |
| `output_labels` | screen-N or channel | `true` / `false` | Labels on/off. Channels also allowed: `current-now current-a current-b current-c control-output-1..4`. | `20,output_labels,screen-1,false` |
| `output_subtitles` | screen-N or channel | `true` / `false` | Japanese captions on/off. Channels allowed as above. | `20,output_subtitles,current-a,false` |
| `output_fade` | screen-N | `original`, `crossfade`, `none` | Image-change transition. | `0,output_fade,screen-1,original` |
| `output_fade_sec` | screen-N | 0..10 (millisecond precision) | Fade length. | `119,output_fade_sec,screen-1,1.0` |
| `output_black_sec` | screen-N | 0..10 (millisecond precision) | Black hold between images. | `0,output_black_sec,screen-1,0.12` |
| `output_face_blur` | screen-N | `true` / `false` | Face blur on/off. | `16,output_face_blur,screen-1,true` |
| `output_blur_px` | screen-N | integer 0..40 | Blur strength. | `16,output_blur_px,screen-1,12` |

Any other action, or any other `output_*` name, is an error ("Unknown action" lists the allowed ones). Inside the table, `\|` is only Markdown escaping: in the CSV write a plain `|`. One row changes exactly one thing.

## 4. Timing and runtime semantics (タイミングと実行時の挙動)

- Operator flow: load the CSV (the full file is checked; any error means nothing loads) -> pause generation -> Play. Play is refused while a generation is running.
- Seconds are measured from Play on one monotonic clock. Each cue fires once when its second is reached, in file order for equal seconds; a failed cue is never retried.
- **Generation**: only `generate` rows generate when the mode is `manual` (or there is no `mode` row). If a `mode` row sets `timer` or `chain` in Live play, the server also auto-captures at that cadence while the scenario runs (timer: every `interval_sec`; chain: 1 s after the previous capture). One generation of A/B/C takes about 50-80 s, so space `generate` rows at least 90 s apart (a request while one is running is not accepted), and keep `interval_sec` >= 90. Generation runs in the background; the scenario clock keeps going.
- **Preview only** (a switch in Control): the clock runs and `output_*` rows are shown as a temporary preview overlay, but `generate` and all settings rows (mode, interval_sec, distance, tone, presence, empty_person, person_refs, pause/resume) are SKIPPED, so nothing is generated or changed. Use it to test display-only CSVs and timings.
- **End** with `loop` false: at N seconds the run completes and the same restore as Stop runs: layout back, screen mapping (outputs) back, every setting the run changed back to its pre-run value (only if it still holds the value the run wrote), then the previously loaded scenario (default SCN-001) is reloaded. Generation hold after a natural end: generation is ENABLED, unless the last pause/resume row applied by the CSV was `pause` (then it stays paused). Stop restores the pre-run hold.
- **Loop true**: at `end` the timeline restarts from 0 (prompts, one-shots and images reset; settings and screens are NOT reset between cycles, so state what you need at second 0). It runs until the operator presses Stop, which restores as above.
- Each Live Play archives the CSV text under `logs/scenario-runs/`.

## 5. Design guidance for good scenes (良いシーンの作り方)

- **Tone** bands: below 0.15 = calm (small natural movement), below 0.45 = quiet (modest), below 0.75 = lively (clear everyday movement), above = big but still ordinary. Good range for exhibition use: 0.1..0.5. In an empty room tone only changes the light.
- **Presence** 0..1 = how present the person is, not how much they move (that is Tone). 0 = nobody (empty room); 0.2-0.35 = a small figure far back or at the frame edge; 0.5 = present but subdued; 0.7+ = fully present at the near desk. On an empty photo it sets whether a recently seen person (never a stranger) appears. Typical: A 0.7, B 0.3, C 0.4.
- **Distances**: A and B are the future (positive seconds, e.g. 30, 60, 150), C is the past (negative, e.g. -30). Larger distances allow larger change; keep |distance| at most about 300 s for believable results.
- Never write theatrical actions (raising both arms, stretching, waving, dancing). Use ordinary things: shifting posture, reaching for a cup, looking up, turning a page, picking up a bag, light changing.
- **Person rule**: only a person who was in the room recently may appear, and then it must be that same person. Never prompt for strangers ("a visitor", "someone enters"). An empty room is fine: describe objects or light only, or write conditionally ("if a person is on screen, that person ..."), as `SCN-SIMPLE-001.csv` does.
- **Captions** are Japanese and derive from the prompt text: write short, plain Japanese sentences (one sentence, roughly 10-30 characters, ending with `。`). For the past scene C use past tense (`...ていた。`).
- **One visible change per cue.** Do not change tone, distance and prompts in the same second as a screen swap; spread them 5-20 s apart. Before a screen swap set `output_fade,...,crossfade` about 1 s earlier and restore `original` after.
- Open every scenario with a block at second 0 that states everything it needs (mode, distances, tone, presence, screens, clear prompts) so it never depends on leftovers.
- Do not leave long generation loops running without purpose (they cost money). Prefer `manual` plus a few `generate` rows.

## 6. Worked examples (実例; all pass the checker)

Validation command (run from the repository root; needs Python 3; prints one JSON object, `"ok": true` or `formatErrors`; exit code 0 = ok, 2 = errors):

```
python scripts/operator-scenario/parse_plan.py path/to/file.csv
```
On a PC without the repository, copy `parse_plan.py`, `scenario_csv.py`, `scenario_engine.py` into one folder and run it there. If no checker is available, follow sections 2, 3 and 7 strictly and tell the user the file was not machine-checked.

### (a) Default loop: SCN-DEFAULT (generates continuously, loops, 10-minute cycle)
```
seconds,action,target,value
0,scenario,,SCN-DEFAULT
0,instructions,,"Default: A and B 30 s in the future, C 30 s in the past, continuous generation, black fade, loops forever, no extra prompts"
0,loop,,true
0,mode,,chain
0,distance,A,30
0,distance,B,30
0,distance,C,-30
0,tone,A,1
0,tone,B,0
0,clear_prompt,A,
0,clear_prompt,B,
0,clear_prompt,C,
0,output_fade,screen-1,original
0,output_fade,screen-2,original
0,output_fade,screen-3,original
0,output_fade,screen-4,original
0,output_source,screen-4,c
600,end,,
```

### (b) 3-minute guided sequence: prompts per scene, three manual generations, screen swap at 2 min
```
seconds,action,target,value
0,scenario,,EX-B-GUIDED
0,instructions,,"3-minute guided sequence: manual mode, three generations 90 s apart, screen swap at 2 min"
0,mode,,manual
0,resume,,
0,distance,A,30
0,distance,B,60
0,distance,C,-30
0,tone,,0.3
0,presence,,0.5
0,output_source,screen-1,a
0,output_source,screen-2,b
0,output_source,screen-3,now
0,output_source,screen-4,c
2,prompt,A,"机で作業を続けている人が、少し姿勢を直す。"
2,prompt,B,"同じ人が、飲み物に手を伸ばす。"
2,prompt,C,"その人が、さっきまで画面を見つめていた。"
5,generate,,
50,note,,"first set is on screen by now"
95,tone,A,0.5
95,one_shot,A,"人が顔を上げて、窓のほうを見る。"
96,generate,,
118,output_fade,screen-1,crossfade
118,output_fade,screen-3,crossfade
120,output_source,screen-1,now
120,output_source,screen-3,a
123,output_fade,screen-1,original
123,output_fade,screen-3,original
130,clear_prompt,A,
130,clear_prompt,B,
130,clear_prompt,C,
150,tone,,0.2
155,generate,,
180,end,,
```

### (c) No-generation, display-only test (safe in Preview and Live)
```
seconds,action,target,value
0,scenario,,EX-C-DISPLAYONLY
0,instructions,,"Display-only test: no generate rows, only screen mapping, visibility and captions"
0,output_source,screen-1,a
0,output_source,screen-2,b
5,output_source,screen-1,c
10,output_visible,screen-2,false
15,output_visible,screen-2,true
20,output_labels,screen-1,false
20,output_subtitles,screen-1,false
25,output_labels,screen-1,true
25,output_subtitles,screen-1,true
30,end,,
```

## 7. Checklist and common errors (チェックリストとよくあるエラー)

Before sending: (1) header is exactly `seconds,action,target,value`; (2) `scenario`, `instructions`, `loop` rows at second 0, once each; (3) an `end` row, every cue <= end (< end if loop); (4) seconds ascending; (5) every Japanese or comma-containing value in double quotes; (6) `generate` rows >= 90 s apart, blank target and value; (7) scenes upper-case A/B/C, screens `screen-N`, booleans lower-case; (8) no theatrical actions, no strangers; (9) the checker prints `"ok": true` and no warning you do not understand; (10) file saved as UTF-8.

Real checker messages for deliberately wrong files (row = CSV line, column in brackets):

```
Misspelled action      -> row 4 [action]: Unknown action: genarate (allowed: instructions, scenario, loop, end, layout, scene_mode, prompt, one_shot, clear_prompt, image, clear_image, mode, interval_sec, presence, tone, empty_person, distance, person_refs, person_refs_once, pause, resume, generate, note, output_*)
Value out of range     -> row 5 [value]: tone must be a number from 0 to 1 (got "1.5")
Bad scene target       -> row 6 [target]: distance target must be A, B or C
Empty prompt           -> row 7 [value]: prompt value cannot be empty
Unquoted ASCII comma   -> row 4: Wrong number of columns: 4 expected, 5 found
Cue after end          -> row 6 [seconds]: Cue at 60s is after end (50s, row 5)
loop without end       -> row 3 [action]: loop true needs an end row after the last cue
Bad screen source      -> row 4 [value]: Invalid output source
Missing image          -> row 5 [value]: Image file not found: missing.png
Fade out of range      -> row 6 [value]: output_fade_sec must be a number from 0 to 10 (got "11")
generate with target   -> row 7 [target]: generate target must be blank
Extra column           -> row 1 [extra]: Unknown column: "extra" (allowed: seconds,action,target,value,source_rect,target_rect,fit,opacity,feather_px,instruction)
Warning only (loads)   -> row 0: No end row; duration defaults to the last cue time
Warning only (loads)   -> row 6 [seconds]: seconds 20 is earlier than row 5 (30); cues run in time order
```
The checker reports every problem in one pass (except after a CSV syntax error such as an unclosed quote, where later rows are not checked). Fix top to bottom and re-run.

## 8. How to deliver (納品方法)

- **MAIN Import (operator, on the tailnet)**: in the Control panel's scenario section use Import... and pick the CSV (plus any PNG images it names). The file is checked on import; errors appear as FORMAT ERROR with row numbers. Then Load, pause generation, Play (use "Preview only" first for anything new).
- **Public /submit/ page (anyone)**: open the link the operator gives you, `https://<host>/submit/?token=<token>` (the token comes from the operator; do not guess or share it). Upload the CSV (<= 2 MB), optionally up to 5 PNG images (PNG only, <= 5 MB each, names of `A-Za-z0-9_. -`), a sender name (<= 40 chars) and a note (<= 200 chars). Rate limit: about 10 submissions per hour per sender. Nothing plays automatically: the operator must approve the submission in Control before it can be loaded or played.
- `image` rows work only when the PNG is delivered with the CSV and `value` is exactly its file name.

## 9. System prompt to give any AI together with this file (そのまま貼るブロック)

```
You are a scenario-CSV author for the "Speculative Memory" installation. Read the attached SCENARIO-AUTHORING-GUIDE.md fully and follow it exactly; it is the only spec you have.
Goal: through conversation with me (in Japanese), design a scenario and output ONE CSV file.
Rules:
1. Header is exactly: seconds,action,target,value (no other columns unless I ask for image overlays).
2. Use only actions listed in guide section 3; never invent actions or screen names; scenes are A, B, C; screens are screen-N.
3. Start with scenario, instructions, loop rows at second 0; always finish with an end row; keep seconds ascending.
4. Quote every text value; write scene prompts as short, ordinary, non-theatrical Japanese sentences; never invent strangers; one visible change per cue.
5. Keep generate rows at least 90 s apart; default to manual mode unless I ask for continuous generation.
6. Ask me at most 3 short questions (duration, mood/tone, screens), then draft. Show the CSV in a code block and explain each section briefly in Japanese.
7. If you can run commands, save the file and run: python scripts/operator-scenario/parse_plan.py <file.csv> and fix every formatError before showing it. If you cannot, re-read guide sections 2, 3 and 7 and self-check line by line, and say it was not machine-checked.
8. Name the file after the scenario ID (e.g. SCN-MYTITLE-001.csv, UTF-8) and tell me to Import it in MAIN or send it via /submit/.
```
