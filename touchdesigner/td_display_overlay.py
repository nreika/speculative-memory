"""Text overlay on the 4 output images (display_a / b / c / now), two independent ON/OFF switches.

  /project1 par Overlaylabel   ON -> scene label ("B  FUTURE +30 s") top-left, in the panel's colour
  /project1 par Overlayprompt  ON -> scene text (the panel text) at the bottom, subtitle style

Inserted between each display's switch TOP and the display_* level TOP, so the overlay fades
with the image and the window assignment (window1..4 winop -> display_*) is untouched.
Texts follow /project1/ui_root/scene_text/p_*/lb and /tx by expression. build() is idempotent.
"""

ROOT = '/project1'
PANELS = '/project1/ui_root/scene_text'
DISPLAY_TO_PANEL = (('display_a', 'p_a'), ('display_b', 'p_b'), ('display_c', 'p_past'), ('display_now', 'p_now'))
FONT = 'Yu Gothic UI'
LABEL_SIZE, LABEL_MARGIN = 30, (36, 28)
PROMPT_SIZE, PROMPT_MARGIN = 30, (110, 34)
SHADOW = (2, -2, 0.85)                 # dx, dy, alpha
TOGGLES = (('Overlaylabel', 'ラベル表示', 'ラベル'), ('Overlayprompt', '字幕表示', '字幕'))
BUTTONS = (('overlay_label_btn', 'Overlaylabel', 'ラベル', 8), ('overlay_prompt_btn', 'Overlayprompt', '字幕', 144))


def _pars():
    root = op(ROOT)
    page = next((p for p in root.customPages if p.name == 'Display'), None) or root.appendCustomPage('Display')
    for name, label, _ in TOGGLES:
        if getattr(root.par, name, None) is None:
            page.appendToggle(name, label=label)[0].val = True


def _text(parent, name, src, x, y, text_expr, color_expr, size, align, margin, wrap, bold):
    t = parent.op(name) or parent.create(textTOP, name)
    t.nodeX, t.nodeY = x, y
    t.inputConnectors[0].connect(src)
    t.par.text.expr = text_expr
    t.par.font = FONT
    t.par.bold = bold
    t.par.fontautosize = 'nofit'
    t.par.fontsizex = size
    t.par.wordwrap = wrap
    t.par.alignx, t.par.aligny = align
    t.par.borderspace1, t.par.borderspace2 = margin
    t.par.bgalpha = 0
    t.par.combineinput = True
    t.par.operand = 'over'
    for i, c in enumerate(('fontcolorr', 'fontcolorg', 'fontcolorb')):
        getattr(t.par, c).expr = color_expr[i] if isinstance(color_expr, tuple) else repr(color_expr)
    return t


def _layer(parent, key, src, x, y, panel_op, which, size, align, margin, wrap, bold, toggle):
    # Empty text when the switch is off -> the Text TOP passes its input through unchanged.
    text_expr = "op({0!r}).par.text.eval() if op({1!r}).par.{2} and op({0!r}) else ''".format(panel_op, ROOT, toggle)
    sh = _text(parent, 'ovl_{}_{}_sh'.format(which, key), src, x, y, text_expr, 0.0, size, align, margin, wrap, bold)
    sh.par.positionx, sh.par.positiony = SHADOW[0], SHADOW[1]
    sh.par.fontalpha = SHADOW[2]
    if which == 'lb':
        color = tuple("op({!r}).par.{}".format(panel_op, c) for c in ('fontcolorr', 'fontcolorg', 'fontcolorb'))
    else:
        color = 1.0
    return _text(parent, 'ovl_{}_{}'.format(which, key), sh, x + 130, y, text_expr, color, size, align, margin, wrap, bold)


def _buttons():
    root = op(ROOT)
    proto, proto_exec = root.op('fade_mode_btn'), root.op('fade_mode_exec')
    for name, toggle, word, x in BUTTONS:
        b = root.op(name) or root.copy(proto, name=name)
        b.par.x, b.par.y, b.par.w, b.par.h = x, 67, 132, 22
        b.par.label.expr = "'{0}: あり' if op('/project1').par.{1} else '{0}: なし'".format(word, toggle)
        ex = root.op(name + '_exec') or root.copy(proto_exec, name=name + '_exec')
        ex.par.panels = b.path
        ex.nodeX, ex.nodeY = b.nodeX, b.nodeY - 120
        ex.text = ("# Toggles /project1 par {0} (td_display_overlay.py).\n\n"
                   "def onOffToOn(panelValue):\n"
                   "    par = op('/project1').par.{0}\n"
                   "    par.val = not par.eval()\n"
                   "    return\n").format(toggle)
    cost = root.op('cost_display')
    if cost is not None:
        cost.par.y, cost.par.h = 91, 16
        cost.par.fontsize = 12
    for n in ('start_display_btn', 'hide_display_btn', 'shuffle_btn', 'reset_layout_btn'):
        b = root.op(n)
        if b is not None:
            b.par.y, b.par.h = 109, 22


def build():
    _pars()
    root = op(ROOT)
    made = []
    for i, (disp_name, panel) in enumerate(DISPLAY_TO_PANEL):
        disp = root.op(disp_name)
        src = disp.inputs[0]
        key = disp_name.split('_', 1)[1]
        if src.name.startswith('ovl_'):          # already built: walk back to the original source
            while src.name.startswith('ovl_'):
                src = src.inputs[0]
        x, y = disp.nodeX - 560, disp.nodeY - 160
        lb = _layer(root, key, src, x, y, '{}/{}/lb'.format(PANELS, panel), 'lb',
                    LABEL_SIZE, ('left', 'top'), LABEL_MARGIN, False, True, 'Overlaylabel')
        tx = _layer(root, key, lb, x + 260, y, '{}/{}/tx'.format(PANELS, panel), 'tx',
                    PROMPT_SIZE, ('center', 'bottom'), PROMPT_MARGIN, True, False, 'Overlayprompt')
        disp.inputConnectors[0].connect(tx)
        made.append(tx.path)
    _buttons()
    return made


def remove():
    """Restore the original wiring (switch -> display_*) and delete the overlay operators."""
    root = op(ROOT)
    for disp_name, _ in DISPLAY_TO_PANEL:
        disp = root.op(disp_name)
        src = disp.inputs[0] if disp.inputs else None
        while src is not None and src.name.startswith('ovl_'):
            src = src.inputs[0]
        if src is not None:
            disp.inputConnectors[0].connect(src)
    for o in list(root.findChildren(name='ovl_*', depth=1)):
        o.destroy()
