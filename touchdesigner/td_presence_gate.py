# -*- coding: utf-8 -*-
"""
Presence gate: pure decision logic (no TouchDesigner API, no I/O).

Used by td_native_capture.py. It decides, from the latest person-detection
result, whether timer / chain captures may run.

States
  off      the option (par Startonperson) is off, or Capturemode is manual.
           Captures behave exactly as before.
  waiting  option on, nobody detected yet: timer / chain captures are held back.
  active   a person was detected recently: captures run.
  paused   nobody for Idlestopsec seconds: captures are held back until the next detection.

Transitions (next_state)
  person True   waiting / paused / off(enabled) -> active and fire=True (start one capture now)
                active -> active
  person False  active and idle_stop_sec > 0 and now - last_person_at >= idle_stop_sec -> paused
                otherwise unchanged (off -> waiting when enabled)
  person None   (unknown: server / VLM failed) never changes a state, never fires
  not enabled   -> off, never fires
"""

STATES = ('off', 'waiting', 'active', 'paused')


def next_state(state, person, now, last_person_at, idle_stop_sec, enabled=True):
    """Returns (new_state, fire). last_person_at is the time of the last detection BEFORE this one
    (the caller updates it when person is True; it is not used in that branch)."""
    if not enabled:
        return 'off', False
    if state not in STATES or state == 'off':
        state = 'waiting'
    if person is True:
        return 'active', state != 'active'
    if person is False:
        if state == 'active' and idle_stop_sec and idle_stop_sec > 0 \
                and last_person_at and now - last_person_at >= idle_stop_sec:
            return 'paused', False
        return state, False
    return state, False


def capture_allowed(state):
    """May a timer / chain capture start? ('off' = option disabled = old behaviour.)"""
    return state in ('off', 'active')


def describe(state, last_person_at, now):
    if state == 'off':
        return 'off'
    if not last_person_at:
        return '{} (no person yet)'.format(state)
    return '{} (last person {:.0f}s ago)'.format(state, max(0.0, now - last_person_at))
