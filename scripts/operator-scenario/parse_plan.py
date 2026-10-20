"""Validate a local CSV on load; the runtime clock and controls belong to Node.

stdout is always one JSON object:
  exit 0: {"ok": true, "plan": {...}, "formatWarnings": [...]}
  exit 2: {"ok": false, "formatErrors": [...], "formatWarnings": [...]}
Each issue is {row, column?, message, severity}; row is the 1-based CSV line
(header = 1), 0 for the file as a whole. Exit 1 (stderr) = unexpected failure."""
import json
import sys
from scenario_csv import check, errors_of, warnings_of

def main(path):
    plan, issues = check(path)
    errors = errors_of(issues)
    if errors:
        out = {'ok': False, 'formatErrors': errors, 'formatWarnings': warnings_of(issues)}
    else:
        out = {'ok': True, 'plan': plan, 'formatWarnings': warnings_of(issues)}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=True).encode('ascii'))
    return 2 if errors else 0

if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1]))
    except Exception as exc:
        sys.stderr.write(type(exc).__name__ + ': ' + str(exc))
        sys.exit(1)
