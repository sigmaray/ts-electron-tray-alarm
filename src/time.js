(function attachAlarmTime(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AlarmTime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAlarmTime() {
  const formatters = new Map();
  const timestampCache = new Map();

  function getFormatter(timeZone) {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
      formatters.set(timeZone, formatter);
    }
    return formatter;
  }

  function localDateTimeInTimezone(timeZone, timestamp) {
    const parts = getFormatter(timeZone).formatToParts(new Date(timestamp));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour'),
      minute: get('minute'),
      second: get('second'),
    };
  }

  function wallTimeAsUtc(parts) {
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  }

  function zonedDateTimeToTimestamp(timeZone, target) {
    const cacheKey = `${timeZone}|${target.year}-${target.month}-${target.day}|${target.hour}:${target.minute}:${target.second}`;
    if (timestampCache.has(cacheKey)) return timestampCache.get(cacheKey);
    const targetWallTime = wallTimeAsUtc(target);
    const offsets = new Set();
    const sampleHours = [-36, 0, 36];
    for (const hours of sampleHours) {
      const sample = targetWallTime + hours * 60 * 60 * 1000;
      const sampleSecond = Math.floor(sample / 1000) * 1000;
      offsets.add(wallTimeAsUtc(localDateTimeInTimezone(timeZone, sampleSecond)) - sampleSecond);
    }

    const candidates = [...offsets].map((offset) => {
      const timestamp = targetWallTime - offset;
      const local = localDateTimeInTimezone(timeZone, timestamp);
      return { timestamp, wallTime: wallTimeAsUtc(local) };
    });
    const exact = candidates.filter((candidate) => candidate.wallTime === targetWallTime);
    if (exact.length) return cacheTimestamp(cacheKey, Math.min(...exact.map((candidate) => candidate.timestamp)));

    // A wall time inside a spring-forward gap resolves to the first corresponding time after the gap.
    const afterGap = candidates
      .filter((candidate) => candidate.wallTime > targetWallTime)
      .sort((a, b) => a.wallTime - b.wallTime || a.timestamp - b.timestamp);
    if (afterGap.length) return cacheTimestamp(cacheKey, afterGap[0].timestamp);

    // If no exact or later candidate exists, use the closest candidate before the requested wall time.
    candidates.sort((a, b) => b.wallTime - a.wallTime || a.timestamp - b.timestamp);
    return cacheTimestamp(cacheKey, candidates[0].timestamp);
  }

  function cacheTimestamp(key, timestamp) {
    if (timestampCache.size >= 4096) timestampCache.clear();
    timestampCache.set(key, timestamp);
    return timestamp;
  }

  function addGregorianCalendarDays(year, month, day, deltaDays) {
    const date = new Date(Date.UTC(year, month - 1, day + deltaDays));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }

  function nextAlarmTimestamp(timeZone, alarm, nowTimestamp) {
    if (Number.isFinite(alarm.scheduledAt)) return alarm.scheduledAt;
    const local = localDateTimeInTimezone(timeZone, nowTimestamp);
    if ((alarm.frequency === 'hourly') || (alarm.recurring && alarm.frequency === 'hourly')) {
      const thisHour = zonedDateTimeToTimestamp(timeZone, { ...local, minute: alarm.minute, second: alarm.second });
      return thisHour > nowTimestamp ? thisHour : thisHour + 60 * 60 * 1000;
    }
    let target = { ...local, hour: alarm.hour, minute: alarm.minute, second: alarm.second };
    let timestamp = zonedDateTimeToTimestamp(timeZone, target);
    if (timestamp <= nowTimestamp) {
      target = { ...addGregorianCalendarDays(local.year, local.month, local.day, 1), hour: alarm.hour, minute: alarm.minute, second: alarm.second };
      timestamp = zonedDateTimeToTimestamp(timeZone, target);
    }
    return timestamp;
  }

  function alarmTimeHasPassedToday(timeZone, alarm, nowTimestamp) {
    const local = localDateTimeInTimezone(timeZone, nowTimestamp);
    const target = zonedDateTimeToTimestamp(timeZone, {
      ...local,
      hour: alarm.hour,
      minute: alarm.minute,
      second: alarm.second,
    });
    return target <= nowTimestamp;
  }

  return { localDateTimeInTimezone, zonedDateTimeToTimestamp, addGregorianCalendarDays, nextAlarmTimestamp, alarmTimeHasPassedToday };
});
