(function attachAlarmListOrder(root, factory) {
  const alarmTime = typeof module !== 'undefined' && module.exports
    ? require('./time.js')
    : root.AlarmTime;
  const api = factory(alarmTime);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AlarmListOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAlarmListOrder(alarmTime) {
  function sortAlarmsForFrequency(alarms, frequency, timeZone, nowTimestamp) {
    if (frequency === 'hourly') {
      return [...alarms].sort((a, b) => Number(b.enabled) - Number(a.enabled)
        || a.minute - b.minute
        || a.second - b.second);
    }

    const statusRank = alarm => alarm.completed ? 2 : alarm.enabled ? 0 : 1;
    const timestampFor = alarm => {
      if (Number.isFinite(alarm.scheduledAt)) return alarm.scheduledAt;
      if (frequency === 'once' && alarm.scheduledDate) {
        const [year, month, day] = alarm.scheduledDate.split('-').map(Number);
        return alarmTime.zonedDateTimeToTimestamp(timeZone, {
          year, month, day, hour: alarm.hour, minute: alarm.minute, second: alarm.second,
        });
      }
      return alarmTime.nextAlarmTimestamp(timeZone, alarm, nowTimestamp);
    };

    return alarms.map((alarm, index) => ({
      alarm,
      index,
      status: statusRank(alarm),
      distance: Math.abs(timestampFor(alarm) - nowTimestamp),
    })).sort((a, b) => a.status - b.status || a.distance - b.distance || a.index - b.index)
      .map(item => item.alarm);
  }

  return { sortAlarmsForFrequency };
});
