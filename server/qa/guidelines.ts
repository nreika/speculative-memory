/** Reads rulebook/USER_GUIDELINES.md into a list for /logs (read-only: the file is edited by people, never by the improver). */

export interface GuidelineItem {
  id: string;
  title: string;
  date?: string;
  /** The user's own words, when the entry quotes them. */
  quote?: string;
  kind: '固定ルール' | '運用' | '候補（未確定）';
}

export function parseGuidelines(md: string): { items: GuidelineItem[]; history: string[] } {
  const items: GuidelineItem[] = [];
  const history: string[] = [];
  const lines = md.split(/\r?\n/);
  let section: 'rules' | 'ops' | 'history' | 'candidates' = 'rules';
  let cur: GuidelineItem | null = null;
  for (const line of lines) {
    const h2 = /^## (.+)$/.exec(line);
    if (h2) {
      cur = null;
      const t = h2[1].trim();
      if (/^運用上の判断/.test(t)) section = 'ops';
      else if (/^追加履歴/.test(t)) section = 'history';
      else if (/^候補/.test(t)) section = 'candidates';
      else {
        const m = /^([GC]-\d+)\s+(.+)$/.exec(t);
        if (m) {
          cur = { id: m[1], title: m[2], kind: m[1].startsWith('C') ? '候補（未確定）' : '固定ルール' };
          items.push(cur);
        }
      }
      continue;
    }
    if (section === 'rules' && cur) {
      const d = /^- 日付: (\d{4}-\d{2}-\d{2})/.exec(line);
      if (d && !cur.date) cur.date = d[1];
      const q = /^- 原文[^:：]*[:：]\s*(.+)$/.exec(line);
      if (q && !cur.quote) cur.quote = q[1];
    } else if (section === 'ops') {
      const m = /^- \*\*(R-\d+) ([^*]+)\*\*(?:（(\d{4}-\d{2}-\d{2})[^）]*）)?/.exec(line);
      if (m) items.push({ id: m[1], title: m[2].trim(), date: m[3], quote: /原文「([^」]+)」/.exec(line)?.[1], kind: '運用' });
    } else if (section === 'history') {
      const m = /^- (.+)$/.exec(line);
      if (m) history.push(m[1]);
    } else if (section === 'candidates') {
      const m = /^- \*\*候補 (C-\d+) ([^*]+)\*\*（(\d{4}-\d{2}-\d{2})/.exec(line);
      if (m) items.push({ id: m[1], title: m[2].trim(), date: m[3], kind: '候補（未確定）' });
    }
  }
  return { items, history };
}
