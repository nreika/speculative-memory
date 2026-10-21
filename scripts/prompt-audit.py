#!/usr/bin/env python3
"""Audit archived image-edit prompts (*_prompt.txt) for incoherence.

Usage: python scripts/prompt-audit.py <generations-dir-or-day-dir> [--since HH-MM-SS] [--show N]

Per prompt it measures:
  len        characters of the positive prompt sent to ComfyUI
  rep        how often the action (first sentence of prediction_prompt, or a 6-word window of it) appears
  awayFace   a person is facing away / seen from behind AND the positive prompt asks for a face action
             (look, gaze, glance, eyes, smile, mouth, expression ...) outside a negated sentence
  awayRef    a person is facing away AND the prompt says image2/image3 show face/identity of the people
             while no non-away person is named as the owner of a reference
Prints totals and averages. The negative prompt is ignored (cfg 1.0 on Turbo makes it inert).
"""
import os
import re
import sys

POS_HEAD = re.compile(r"^=== 画像プロンプト全文.*?===\s*$", re.M)
NEG_HEAD = re.compile(r"^=== ネガティブプロンプト ===\s*$", re.M)
PRED_HEAD = re.compile(r"^=== 予測プロンプト \(prediction_prompt\) ===\s*$", re.M)
SECTION = re.compile(r"^=== .* ===\s*$", re.M)
AWAY = re.compile(r"facing away|seen from behind|back of (?:the )?head (?:to|toward) (?:the )?camera|back turned to the camera", re.I)
FACE_ACTION = re.compile(r"\b(?:look(?:s|ing|ed)?|gaz\w*|glanc\w*|eyes?|smil\w*|laugh\w*|mouth|expression|grin\w*|frown\w*|stares?|staring|facial)\b", re.I)
NEGATED = re.compile(r"\b(?:never|not|no|without|hidden|stays? hidden)\b", re.I)
FACE_REF = re.compile(r"image2(?:/image3)?\s+(?:shows|show|are|is)\b[^.]*\b(?:face|identity)\b", re.I)


def section(text, head):
    m = head.search(text)
    if not m:
        return ""
    rest = text[m.end():]
    n = SECTION.search(rest)
    return (rest[: n.start()] if n else rest).strip()


def norm(s):
    return re.sub(r"\s+", " ", s).strip().lower()


def first_sentence(s):
    s = norm(s)
    m = re.search(r"[.!?](\s|$)", s)
    return (s[: m.start() + 1] if m else s).rstrip(".!?")


def action_reps(pos, pred):
    p = norm(pos)
    sent = first_sentence(pred)
    if len(sent) >= 12 and sent in p:
        return p.count(sent)
    words = re.findall(r"[a-z']+", sent)
    # The action counts as repeated only when every 6-word window of it that occurs at all occurs 2+ times
    # (a person label such as "the person in the striped shirt" may legitimately appear in the who clause too).
    flat = " ".join(re.findall(r"[a-z']+", p))
    counts = []
    for i in range(0, max(1, len(words) - 5)):
        win = " ".join(words[i : i + 6])
        if len(win) >= 15:
            c = len(re.findall(r"(?<![a-z'])" + re.escape(win) + r"(?![a-z'])", flat))
            if c:
                counts.append(c)
    return min(counts) if counts else 0


def sentences(s):
    return [x for x in re.split(r"(?<=[.!?;:])\s+", s) if x.strip()]


def audit(path):
    text = open(path, encoding="utf-8", errors="replace").read()
    pos = section(text, POS_HEAD)
    pred = section(text, PRED_HEAD)
    if not pos:
        return None
    away = bool(AWAY.search(pos))
    face = any(FACE_ACTION.search(s) and not NEGATED.search(s) for s in sentences(pos))
    ref = bool(FACE_REF.search(pos))
    return {
        "path": path,
        "len": len(pos),
        "rep": action_reps(pos, pred) if pred else 0,
        "awayFace": away and face,
        "awayRef": away and ref and not re.search(r"image\d shows the (?:face|appearance)", pos, re.I),
        "pos": pos,
    }


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    root = args[0]
    since = args[args.index("--since") + 1] if "--since" in args else None
    show = int(args[args.index("--show") + 1]) if "--show" in args else 0
    files = []
    for dp, _, fs in os.walk(root):
        for f in fs:
            if f.endswith("_prompt.txt"):
                if since and os.path.basename(dp)[-8:] < since:
                    continue
                files.append(os.path.join(dp, f))
    rows = [r for r in (audit(f) for f in sorted(files)) if r]
    if not rows:
        print("no prompts")
        return
    n = len(rows)
    lens = sorted(r["len"] for r in rows)
    print(f"prompts: {n}")
    print(f"length: mean {sum(lens) // n}, median {lens[n // 2]}, max {lens[-1]}, under 1200: {sum(l < 1200 for l in lens)}")
    print(f"action repeated 2+ times: {sum(r['rep'] >= 2 for r in rows)}  (mean reps {sum(r['rep'] for r in rows) / n:.2f})")
    print(f"away + face-action words: {sum(r['awayFace'] for r in rows)}")
    print(f"away + face/identity reference sentence: {sum(r['awayRef'] for r in rows)}")
    for r in rows[-show:] if show else []:
        print("\n---", r["path"], r["len"], "chars, reps", r["rep"], "awayFace", r["awayFace"], "awayRef", r["awayRef"])
        print(r["pos"])


if __name__ == "__main__":
    main()
