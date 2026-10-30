const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse the date formats used by our datasets into a UTC Date:
 *  - LoCoMo:      "1:56 pm on 8 May, 2023"
 *  - LongMemEval: "2023/05/20 (Sat) 02:21"
 *  - ISO / YYYY-MM-DD / anything Date can parse
 * @returns {Date|null}
 */
export function parseDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return new Date(value);
  const s = String(value).trim();

  let m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === "pm") h += 12;
    const mon = MONTHS[m[5].toLowerCase()];
    if (mon !== undefined) return new Date(Date.UTC(Number(m[6]), mon, Number(m[4]), h, Number(m[2])));
  }

  m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})(?:\s*\([A-Za-z]+\))?(?:\s+(\d{2}):(\d{2}))?$/);
  if (m) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)));
  }

  m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1)));

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

export function daysBetween(a, b) {
  return (b.getTime() - a.getTime()) / DAY_MS;
}

/** "2023-05-08" */
export function isoDay(value) {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 10) : "";
}

/** "8 May 2023" — the format LoCoMo gold answers use. */
export function humanDay(value) {
  const date = parseDate(value);
  if (!date) return "";
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${date.getUTCDate()} ${names[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
