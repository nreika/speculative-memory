/**
 * The v1 wording of every fixed prompt constraint (moved here unchanged from orchestrator.ts / comfyClient.ts / vlmClient.ts).
 * A leaf module (no imports) so that the rulebook, the orchestrator and the ComfyUI client can all read it.
 * Runtime code does NOT use these directly: it reads the active rulebook (server/generation/rulebook.ts), whose v1
 * (rulebook/rulebook.v1.json) is built from exactly these strings.
 */

/** Appended to every edit instruction; says nothing about clocks (naming one when the frame has none makes the model paint one). */
export const QUALITY_SUFFIX =
  "Sharp, crisp, high-detail photo, in focus edge to edge, fully solid opaque people, no transparency, no ghosting. " +
  "Keep the exact same number of monitors, screens and furniture as the input — do not add or remove any. " +
  "Do not change what any monitor or TV displays. " +
  "Each person has exactly two arms and two hands. When a person moves, redraw them in the new pose and at the new spot only: " +
  "their previous position (any moved arm, hand or body) must disappear completely and show whatever was behind them. " +
  "No duplicated limbs, hands or people. " +
  "Do not add any new object or person that is not in the input; when an object moves, remove it from its original position so it appears only once.";

/** QUALITY_SUFFIX variant for a high Presence setting (a person who enters is allowed, drawn once with two arms). */
export const QUALITY_SUFFIX_ENTERING = QUALITY_SUFFIX.replace(
  "Do not add any new object or person that is not in the input;",
  "Do not add any new object; a new person may appear only if the instruction says someone enters the frame, exactly once and with exactly two arms and two hands;"
);

/** Added to the quality suffix only when a visible clock/number sign is being edited. */
export const CLOCK_QUALITY_SUFFIX =
  "The only text that may change is the physical flip-number sign; keep it as two rows of two-digit cards, " +
  "always showing a leading zero (08, not 8), same size and position as the input.";

/** Added last for long time spans (>= 2 min): the edit model tends to redraw the whole room otherwise. */
export const LONG_SPAN_QUALITY_SUFFIX =
  "This is the same photograph: identical camera position, zoom and viewpoint. The desks, chairs, bag, laptops, cables, curtains, floor and walls " +
  "stay exactly where they are and exactly as they look in the input; only the person's pose and position change. Do not zoom, shift or re-compose the view.";

export const DEFAULT_NEGATIVE_PROMPT =
  "blurry, soft focus, out of focus, hazy, low detail, motion blur, " +
  "transparent, translucent, see-through, ghost, double exposure, " +
  "creature, monster face, melted face, distorted face, disfigured, deformed hands, extra limbs, " +
  "duplicated person, merged bodies, extra people, " +
  "extra monitor, additional screen, more televisions, duplicated display, extra furniture, " +
  "changed screen content, different monitor image, " +
  "disembodied hands, floating arms, limbs growing from furniture, " +
  "giant mesh, oversized foreground object, warped mesh, inflated chair, moire, " +
  "floating object, object hanging on chair back, levitating laptop, " +
  "extra chair, additional bag, added furniture, " +
  "arms raised overhead, stretching arms up, waving, " +
  "hair color change, different hairstyle, changed hair length";

/** Digit guards, only when a clock edit applies. */
export const CLOCK_NEGATIVE_PROMPT = "single-digit clock number, missing leading zero, garbled digits, distorted numbers";

/** Empty room: person words in the negative prompt (inert at cfg 1, active above). */
export const NO_PERSON_NEGATIVE_PROMPT =
  "person, people, man, woman, human, human figure, face, hands, silhouette, shadow of a person, " +
  "dark figure, black silhouette, standing figure, shadow person, mannequin";

export const BEHIND_VIEW_NEGATIVE_PROMPT =
  "face visible, looking at camera, frontal face, giant person, person too close to camera, oversized figure, cropped body filling frame, " +
  "two people, second person, duplicate person, extra person";

/** A recently seen person is drawn from behind: no face. */
export const BEHIND_VIEW_RULE = "The person is seen from behind with their back turned to the camera; the face is not visible.";
/** The recent-person path draws exactly ONE person. */
export const ONE_PERSON_RULE = "Exactly one person appears in the whole image, and no second person or duplicate.";
/** G-13: hair never changes. */
export const HAIR_RULE = "Keep each person's hairstyle, hair length and hair colour exactly as in the input (and the reference image).";
/** G-07: support and gravity. */
export const PHYSICS_RULE =
  "Objects rest on surfaces in physically plausible positions (laptops and cups on desks, bags on the floor or a chair seat); nothing hangs on a chair back or floats in the air; gravity and support stay realistic.";
/** G-06: near-camera objects keep their real-world scale; `{fg}` is the planner's description. */
export const FOREGROUND_RULE_NAMED =
  "Near-camera foreground object ({fg}) keeps its real-world scale, outline, position and texture exactly as in the input; do not enlarge, bend, inflate or turn it into a wall, sail or sculpture.";
export const FOREGROUND_RULE_GENERIC =
  "Near-camera foreground objects keep their real-world scale, outline, position and texture exactly as in the input (e.g. the dark mesh in the foreground is the backrest of an ordinary office chair very close to the camera); do not enlarge, bend, inflate or turn them into a wall, sail or sculpture.";
/** G-04. */
export const DISEMBODIED_RULE =
  "Do not add disembodied body parts; arms and hands must belong to a visible person; never attach limbs to furniture or objects.";
/** Recent-person path: the same-place / same-scale sentence (second half; the first half is built from the person facts). */
export const BEHIND_VIEW_PLACEMENT_RULE =
  "a full figure in the middle or background of the room, never close to the camera, never filling the frame.";
export const REFERENCE_PERSON_RULE =
  "If a person appears, it must be the person shown in the second reference image (same clothing and hair); never a different person.";
export const EMPTY_ROOM_NO_PERSON_RULE =
  "The room is empty: do not add any person, figure, hand, arm or silhouette anywhere in the image; nobody enters.";

/** G-01: the unoccupied-room template has NO person words at all. Pieces in order. */
export const EMPTY_ROOM = {
  head: "Edit this exact photo according to: ",
  scope:
    "Change only the lighting and small in-place details of the objects named. Everything else - the room, walls, floor, ceiling, background, furniture, camera, lighting, the number of monitors and what each monitor displays - stays pixel-identical to the input.",
  keep: "Keep every object, the furniture, the camera and the framing identical to the input.",
  preserve: "Preserve the empty floor and the empty chairs exactly as they are.",
  noAdd: "Do not add any object that is not in the photo; every object stays exactly where it is.",
  screens: "Keep the number of monitors, screens and furniture, and what each screen displays, identical.",
  tail: "Sharp, crisp, high-detail photo, in focus edge to edge. Do not add any new object; every object appears exactly once.",
};

/** Marker in the VLM instruction where rulebook.vlm.extraInstructions are inserted (before the JSON-format part). */
export const VLM_EXTRA_MARKER = "Return ONLY a JSON object of the form ";

/**
 * How big the change from the input may be, by tone band (CALM < 0.15, QUIET < 0.45, LIVELY < 0.75, DRAMATIC).
 * Appended to the image edit instruction so tone steers the picture, not only the planner. People wording: no big arm
 * gestures (G-11); the examples use face, shoulders, torso and light. The empty-room variants contain no person words.
 */
export const TONE_IMAGE_RULES: string[] = [
  "Amount of change: keep it minimal. Only micro-movements of the people already in the picture, and the lighting, colour temperature and time of day stay almost exactly as in the input.",
  "Amount of change: keep it small. A gentle change of pose or gaze, and only a slight change of the lighting; the time of day advances very little.",
  "Amount of change: make it clearly visible. A clearly different pose and facial expression, and a noticeable but natural change of the light (somewhat brighter or dimmer, warmer or cooler) as far as the time span allows.",
  "Amount of change: make it large and unmistakable. A strong, abrupt pose and facial expression (face, shoulders and torso), and a clear change of the light (brightness and colour shifting towards morning or evening, a visible lamp switching on or off) as far as the time span allows; the room, objects and camera stay identical.",
];
export const TONE_IMAGE_RULES_EMPTY: string[] = [
  "Amount of change: keep it minimal. The light changes only barely, a slight shift of brightness.",
  "Amount of change: keep it small. The light shifts slightly in brightness or colour temperature, and shadows move a little.",
  "Amount of change: make it clearly visible. The light visibly changes, clearly brighter or dimmer, warmer or cooler, with shadows that have moved, as far as the time span allows.",
  "Amount of change: make it large. The light changes strongly, a big shift of brightness and colour with long or moved shadows, or a visible lamp switching on or off, as far as the time span allows; everything else in the room stays identical.",
];
