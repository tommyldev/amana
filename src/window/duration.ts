const UNIT_MS: Record<string, number> = {
  ns: 1e-6, nsec: 1e-6,
  us: 1e-3, usec: 1e-3, "µs": 1e-3,
  ms: 1, msec: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  month: 2_629_746_000, months: 2_629_746_000,
  y: 31_557_600_000, year: 31_557_600_000, years: 31_557_600_000,
};

/**
 * Parse a humantime-style duration string ("5h", "1h30m", "90s") into
 * milliseconds. Throws on empty input or an unknown/invalid unit.
 */
export function parseDurationMs(input: string): number {
  const s = input.trim();
  if (s.length === 0) throw new Error("empty duration");
  const re = /(\d+(?:\.\d+)?)\s*([a-zµ]+)/gy;
  let total = 0;
  let matched = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const mult = UNIT_MS[m[2]!.toLowerCase()];
    if (mult === undefined) throw new Error(`bad duration '${input}': unknown unit '${m[2]}'`);
    total += Number(m[1]) * mult;
    matched = re.lastIndex;
  }
  if (matched === 0 || s.slice(matched).trim().length > 0) {
    throw new Error(`bad duration '${input}'`);
  }
  return Math.round(total);
}

const WEEKDAYS: Record<string, number> = {
  mon: 0, monday: 0,
  tue: 1, tues: 1, tuesday: 1,
  wed: 2, wednesday: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3,
  fri: 4, friday: 4,
  sat: 5, saturday: 5,
  sun: 6, sunday: 6,
};

/** Parse a weekday string to a Monday-indexed number (Mon=0..Sun=6). */
export function parseWeekday(s: string): number | undefined {
  return WEEKDAYS[s.toLowerCase()];
}
