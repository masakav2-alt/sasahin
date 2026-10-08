// 最小限の iCalendar(.ics) パーサ。Google カレンダー / Outlook のエクスポートを取り込む用途。
function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '');
}

function parseDt(value, params) {
  const v = value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    // Z 無しは浮動時刻/TZID 付き。TZID 解決はせず Asia/Tokyo(+09:00) とみなす。
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : '+09:00'}`);
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m && /VALUE=DATE/i.test(params)) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`);
  return null;
}

export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(String(text)).split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      if (cur?.start) events.push({ summary: cur.summary ?? '', location: cur.location ?? '', start: cur.start, end: cur.end ?? null });
      cur = null;
    } else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name, ...rest] = line.slice(0, i).split(';');
      const val = line.slice(i + 1);
      const un = (s) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
      if (name === 'DTSTART') cur.start = parseDt(val, rest.join(';'));
      else if (name === 'DTEND') cur.end = parseDt(val, rest.join(';'));
      else if (name === 'SUMMARY') cur.summary = un(val);
      else if (name === 'LOCATION') cur.location = un(val);
    }
  }
  return events.filter((e) => e.start && !Number.isNaN(e.start.getTime()));
}
