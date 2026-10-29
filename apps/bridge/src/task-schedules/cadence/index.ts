type Schedule = { frequency: string; interval: number; hour: number; minute: number; days: Set<string> };

function parse(rule: string): Schedule | undefined {
  const pairs = rule.replace(/^RRULE:/, '').split(';').map(part => part.split('='));
  if (pairs.some(pair => pair.length !== 2)) return undefined;
  const fields = new Map(pairs.map(([key, value]) => [key!, value!]));
  if (fields.size !== pairs.length) return undefined;
  const frequency = fields.get('FREQ') ?? '', intervalText = fields.get('INTERVAL') ?? '1';
  if (!/^[1-9]\d{0,3}$/.test(intervalText)) return undefined;
  const interval = Number(intervalText);
  if (['MINUTELY', 'HOURLY'].includes(frequency)) {
    return [...fields.keys()].every(key => ['FREQ', 'INTERVAL'].includes(key))
      ? { frequency, interval, hour: 0, minute: 0, days: new Set() } : undefined;
  }
  if (!['DAILY', 'WEEKLY'].includes(frequency) || interval !== 1
    || [...fields.keys()].some(key => !['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'BYDAY'].includes(key))) return undefined;
  const hourText = fields.get('BYHOUR') ?? '', minuteText = fields.get('BYMINUTE') ?? '';
  if (!/^\d{1,2}$/.test(hourText) || Number(hourText) > 23 || !/^\d{1,2}$/.test(minuteText) || Number(minuteText) > 59) return undefined;
  const dayValues = fields.has('BYDAY') ? fields.get('BYDAY')!.split(',') : [], days = new Set(dayValues);
  if (frequency === 'DAILY' && fields.has('BYDAY')) return undefined;
  if (frequency === 'WEEKLY' && (days.size === 0 || days.size !== dayValues.length
    || [...days].some(day => !['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].includes(day)))) return undefined;
  return { frequency, interval, hour: Number(hourText), minute: Number(minuteText), days };
}

export function validateScheduleRule(rule: string): boolean { return parse(rule) !== undefined; }

/** One next native timestamp, not a scheduler. Civil dates keep daily/weekly times through DST. */
export function nextNativeOccurrence(rule: string, now: number): number {
  const schedule = parse(rule);
  if (!schedule) throw Error('Choose a supported schedule.');
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) throw Error('The computer clock is unavailable.');
  if (['MINUTELY', 'HOURLY'].includes(schedule.frequency)) {
    return now + (schedule.frequency === 'MINUTELY' ? 60_000 : 3_600_000) * schedule.interval;
  }
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(current.getFullYear(), current.getMonth(), current.getDate() + offset, schedule.hour, schedule.minute);
    const day = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][candidate.getDay()]!;
    if (candidate.getTime() > now && (schedule.days.size === 0 || schedule.days.has(day))) return candidate.getTime();
  }
  throw Error('This schedule has no future occurrence.');
}
