// Your own clock: reports, the dashboard's "today" and the lead engine's daily limit follow
// report_timezone (default: this computer's timezone), so a day starts at YOUR midnight.
// The sending limit keeps using the recipients' day (send_timezone) — see outreach.js.
import { getSetting } from './settings.js';

export const reportTimezone = () => getSetting('report_timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Database timestamps are either ISO ("…Z") or SQLite's "YYYY-MM-DD HH:MM:SS" (UTC). */
export const parseTs = (t) => new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(String(t)) ? t : `${String(t).replace(' ', 'T')}Z`);

function parts(d, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}

/** The instant the day containing `d` started, in timezone `tz`. */
export function dayStartIn(d = new Date(), tz = reportTimezone()) {
  const z = parts(d, tz);
  const offset = Date.UTC(z.y, z.mo - 1, z.d, z.hour, z.minute, z.second) - Math.floor(d.getTime() / 1000) * 1000;
  return new Date(Date.UTC(z.y, z.mo - 1, z.d) - offset);
}

/** The next midnight after `d`, in timezone `tz`. */
export const nextDayStartIn = (d = new Date(), tz = reportTimezone()) => dayStartIn(new Date(dayStartIn(d, tz).getTime() + 36 * 3600_000), tz);
