const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function normalizeQuoteTimestamp(text: string): string {
  const value = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](.+)$/i.exec(value);
  const named = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})[,\s]+(.+)$/.exec(value);
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})[,\s]+(.+)$/.exec(value);
  let year: number, month: number, day: number, clock: string;
  if (iso) {
    year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); clock = iso[4]!;
  } else if (named) {
    year = Number(named[3]); month = months.indexOf(named[2]!.toLowerCase()) + 1;
    day = Number(named[1]); clock = named[4]!;
  } else if (numeric) {
    year = Number(numeric[3]); month = Number(numeric[2]); day = Number(numeric[1]); clock = numeric[4]!;
  } else {
    throw new Error('Unsupported quote timestamp: use a complete source date, time and explicit timezone');
  }
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(AM|PM)?\s*(Z|IST|[+-]\d{2}:?\d{2})$/i.exec(clock);
  if (!time) throw new Error('Quote timestamp must include time and explicit timezone; do not infer missing components');
  let hour = Number(time[1]);
  const minute = Number(time[2]), second = Number(time[3] ?? 0);
  const millis = Number((time[4] ?? '').padEnd(3, '0'));
  if (time[5]) {
    if (hour < 1 || hour > 12) throw new Error('Invalid quote timestamp hour');
    hour = hour % 12 + (time[5].toUpperCase() === 'PM' ? 12 : 0);
  }
  const zone = time[6]!.toUpperCase().replace(':', '');
  const offsetHour = zone === 'IST' ? 5 : zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === 'IST' ? 30 : zone === 'Z' ? 0 : Number(zone.slice(3, 5));
  if (year < 1900 || month < 1 || month > 12 || day < 1 || hour > 23 ||
      minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)) throw new Error('Invalid quote timestamp components');
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) {
    throw new Error('Invalid quote timestamp date');
  }
  const offset = (offsetHour * 60 + offsetMinute) * (zone.startsWith('-') ? -1 : 1);
  return new Date(local.getTime() - offset * 60_000).toISOString();
}
