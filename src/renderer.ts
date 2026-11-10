// Types for the Electron API
interface Alarm {
  id: string;
  hour: number;
  minute: number;
  second: number;
  enabled: boolean;
  recurring: boolean;
  frequency?: 'once' | 'daily' | 'hourly';
  notificationMode?: 'system' | 'window' | 'both';
  postponeMinutes?: number;
  sound?: 'classic' | 'digital' | 'gentle' | 'none';
  scheduledAt?: number;
  scheduledDate?: string;
  dateExplicit?: boolean;
  message?: string;
  completed?: boolean;
}

interface ElectronAPI {
  minimizeWindow: () => void;
  closeApp: () => void;
  openSettingsWindow: () => void;
  closeAlarmCreationWindow: () => void;
  addAlarm: (alarm: Alarm) => Promise<{ ok: boolean; error?: string }>;
  updateAlarm: (alarm: Alarm) => Promise<{ ok: boolean; error?: string }>;
  deleteAlarm: (alarmId: string) => Promise<{ ok: boolean; error?: string }>;
  previewAlarm: (options: { notificationMode: 'system' | 'window' | 'both'; message?: string; sound: 'classic' | 'digital' | 'gentle' | 'none'; hour: number; minute: number; second: number }) => Promise<{ ok: boolean; error?: string }>;
  getAllAlarms: () => void;
  dismissAlarm: () => void;
  onAlarmsUpdated: (callback: (alarms: Alarm[]) => void) => void;
  onAlarmTriggered: (callback: (alarmId: string) => void) => void;
  onAlarmDismissFromMain: (callback: () => void) => void;
  removeAlarmsUpdatedListener: () => void;
  removeAlarmTriggeredListener: () => void;
  toggleCountdownWindow: () => void;
  onCountdownWindowState: (callback: (visible: boolean) => void) => void;
  onCountdownUpdate: (callback: (text: string) => void) => void;
  getTimezones: () => Promise<string[]>;
  getCurrentTimezone: () => Promise<{ effective: string; isSystem: boolean }>;
  onTimezoneUpdated: (callback: (info: { effective: string; isSystem: boolean }) => void) => void;
}

let alarms: Alarm[] = [];
let audioContext: AudioContext | null = null;
let audioInterval: NodeJS.Timeout | null = null;
let isAlarmPlaying: boolean = false;
let isAlarmTriggered = false;
let soundTestInterval: ReturnType<typeof setInterval> | null = null;
let timeUpdateInterval: NodeJS.Timeout | null = null;
let currentTimezoneInfo: { effective: string; isSystem: boolean } | null = null;
let timeTimezoneInterval: ReturnType<typeof setTimeout> | null = null;
let pendingNewAlarmScheduledAt: number | undefined;
let pendingNewAlarmDate: string | undefined;
let pendingNewAlarmMessage = '';
let ringingAlarmId: string | null = null;
let optionsAlarmId: string | null = null;
const isStandaloneAddWindow = new URLSearchParams(location.search).get('alarmDialogOnly') === '1';
const alarmTime = (window as any).AlarmTime;
const alarmListOrder = (window as any).AlarmListOrder;

function updateTimeTimezoneDisplay(): void {
  const el = document.getElementById('currentTimeTimezone');
  if (!el || !currentTimezoneInfo) return;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: currentTimezoneInfo.effective,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const timeStr = formatter.format(new Date());
  const tzLabel = currentTimezoneInfo.isSystem
    ? `System time zone: ${currentTimezoneInfo.effective}`
    : ` ${currentTimezoneInfo.effective}`;
  el.textContent = `${timeStr} (${tzLabel})`;
}

function generateAlarmId(): string {
  return `alarm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function formatTime(hour: number, minute: number, second: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function getLocalTimeFromTimestamp(tz: string, timestamp: number): { hour: number; minute: number; second: number } {
  const local = alarmTime.localDateTimeInTimezone(tz, timestamp);
  return { hour: local.hour, minute: local.minute, second: local.second };
}

function dateInTimezone(tz: string, timestamp: number): string {
  const local = alarmTime.localDateTimeInTimezone(tz, timestamp);
  return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
}

function openAlarmOptions(alarmId?: string): void {
  const overlay = document.getElementById('alarmOptionsOverlay');
  const dateInput = document.getElementById('alarmOptionsDate') as HTMLInputElement | null;
  const messageInput = document.getElementById('alarmOptionsMessage') as HTMLTextAreaElement | null;
  const hourInput = document.getElementById('alarmOptionsHour') as HTMLInputElement | null;
  const minuteInput = document.getElementById('alarmOptionsMinute') as HTMLInputElement | null;
  const secondInput = document.getElementById('alarmOptionsSecond') as HTMLInputElement | null;
  const dateField = document.getElementById('alarmOptionsDateField');
  const dateControls = document.getElementById('alarmOptionsDateControls');
  const quickTimeControls = document.querySelector<HTMLElement>('.quick-time');
  const setDateButton = document.getElementById('setAlarmDateBtn') as HTMLButtonElement | null;
  const frequencyInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="alarmFrequency"]'));
  const soundInput = document.getElementById('alarmOptionsSound') as HTMLSelectElement | null;
  const soundEnabledInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="alarmSoundEnabled"]'));
  const soundControls = document.getElementById('alarmSoundControls');
  if (!overlay || !dateInput || !dateField || !dateControls || !setDateButton || !messageInput || !hourInput || !minuteInput || !secondInput) return;
  optionsAlarmId = alarmId ?? null;
  const tz = getEffectiveTimezoneForQuick();
  if (alarmId) {
    const alarm = alarms.find(item => item.id === alarmId);
    if (!alarm) return;
    const time = alarm.scheduledAt === undefined ? alarm : getLocalTimeFromTimestamp(tz, alarm.scheduledAt);
    hourInput.value = String(time.hour).padStart(2, '0');
    minuteInput.value = String(time.minute).padStart(2, '0');
    secondInput.value = String(time.second).padStart(2, '0');
    const frequency = alarm.frequency ?? (alarm.recurring ? 'daily' : 'once');
    frequencyInputs.forEach(input => input.checked = input.value === frequency);
    const dateWasExplicit = frequency === 'once' && (alarm.dateExplicit ?? alarm.scheduledDate !== undefined);
    dateInput.value = dateWasExplicit ? (alarm.scheduledDate ?? (alarm.scheduledAt === undefined ? '' : dateInTimezone(tz, alarm.scheduledAt))) : '';
    dateField.hidden = !dateWasExplicit;
    setDateButton.hidden = dateWasExplicit;
    messageInput.value = alarm.message ?? '';
    if (soundInput) soundInput.value = alarm.sound === 'digital' || alarm.sound === 'gentle' ? alarm.sound : 'classic';
    soundEnabledInputs.forEach(input => input.checked = input.value === (alarm.sound === 'none' ? 'no' : 'yes'));
    const mode = alarm.notificationMode ?? 'window';
    (document.getElementById(mode === 'system' ? 'notificationSystem' : mode === 'both' ? 'notificationBoth' : 'notificationWindow') as HTMLInputElement).checked = true;
    document.getElementById('alarmOptionsTitle')!.textContent = 'Edit alarm';
  } else {
    const target = pendingNewAlarmScheduledAt ?? Date.now() + 60_000;
    const time = getLocalTimeFromTimestamp(tz, target);
    hourInput.value = String(time.hour).padStart(2, '0');
    minuteInput.value = String(time.minute).padStart(2, '0');
    secondInput.value = String(time.second).padStart(2, '0');
    frequencyInputs.forEach(input => input.checked = input.value === 'once');
    dateInput.value = pendingNewAlarmDate ?? (pendingNewAlarmScheduledAt === undefined ? '' : dateInTimezone(tz, pendingNewAlarmScheduledAt));
    const dateWasExplicit = !!dateInput.value;
    dateField.hidden = !dateWasExplicit;
    setDateButton.hidden = dateWasExplicit;
    messageInput.value = pendingNewAlarmMessage;
    if (soundInput) soundInput.value = 'classic';
    soundEnabledInputs.forEach(input => input.checked = input.value === 'yes');
    (document.getElementById('notificationWindow') as HTMLInputElement).checked = true;
    document.getElementById('alarmOptionsTitle')!.textContent = 'Add alarm';
  }
  const updateHourlyLabel = () => { document.getElementById('hourlyMinuteLabel')!.textContent = minuteInput.value.padStart(2, '0'); };
  const updateSoundControls = () => {
    const soundEnabled = soundEnabledInputs.find(input => input.checked)?.value !== 'no';
    if (soundControls) soundControls.hidden = !soundEnabled;
    if (!soundEnabled && soundTestInterval) {
      clearTimeout(soundTestInterval);
      soundTestInterval = null;
      stopAlarmSound();
      const testButton = document.getElementById('soundTestBtn');
      if (testButton) testButton.textContent = 'Test';
    }
  };
  soundEnabledInputs.forEach(input => input.onchange = updateSoundControls);
  updateSoundControls();
  minuteInput.oninput = updateHourlyLabel;
  updateHourlyLabel();
  const updateFrequencyFields = () => {
    const selectedFrequency = frequencyInputs.find(input => input.checked)?.value;
    const hourly = selectedFrequency === 'hourly';
    const once = selectedFrequency === 'once';
    if (quickTimeControls) quickTimeControls.style.setProperty('display', hourly ? 'none' : 'flex', 'important');
    dateControls.hidden = !once;
    dateField.hidden = !once || !dateInput.value;
    setDateButton.hidden = !once || !!dateInput.value;
    const timeGroup = hourInput.parentElement?.parentElement;
    if (timeGroup) {
      (timeGroup.children[0] as HTMLElement).hidden = hourly;
      (timeGroup.children[1] as HTMLElement).hidden = hourly;
      (timeGroup.children[3] as HTMLElement).hidden = hourly;
      (timeGroup.children[4] as HTMLElement).hidden = hourly;
    }
    if (hourly) { hourInput.value = '00'; secondInput.value = '00'; }
  };
  frequencyInputs.forEach(input => input.onchange = updateFrequencyFields);
  setDateButton.onclick = () => {
    if (!dateInput.value) {
      const existingAlarm = alarmId ? alarms.find(item => item.id === alarmId) : undefined;
      dateInput.value = existingAlarm?.scheduledDate ?? dateInTimezone(tz, Date.now());
    }
    dateField.hidden = false;
    setDateButton.hidden = true;
  };
  const removeDateButton = document.getElementById('removeAlarmDateBtn') as HTMLButtonElement | null;
  if (removeDateButton) removeDateButton.onclick = () => {
    dateInput.value = '';
    dateField.hidden = true;
    setDateButton.hidden = false;
  };
  dateInput.onchange = () => {
    const hasDate = dateInput.value !== '';
    dateField.hidden = !hasDate;
    setDateButton.hidden = hasDate;
  };
  updateFrequencyFields();
  overlay.classList.add('modal-overlay--visible', 'show');
}

async function saveAlarmOptions(): Promise<void> {
  const overlay = document.getElementById('alarmOptionsOverlay');
  const dateInput = document.getElementById('alarmOptionsDate') as HTMLInputElement | null;
  const messageInput = document.getElementById('alarmOptionsMessage') as HTMLTextAreaElement | null;
  const hourInput = document.getElementById('alarmOptionsHour') as HTMLInputElement | null;
  const minuteInput = document.getElementById('alarmOptionsMinute') as HTMLInputElement | null;
  const secondInput = document.getElementById('alarmOptionsSecond') as HTMLInputElement | null;
  const frequency = document.querySelector<HTMLInputElement>('input[name="alarmFrequency"]:checked')?.value as 'once' | 'daily' | 'hourly' | undefined;
  const notificationMode = document.querySelector<HTMLInputElement>('input[name="notificationMode"]:checked')?.value as 'system' | 'window' | 'both' | undefined;
  const soundEnabled = document.querySelector<HTMLInputElement>('input[name="alarmSoundEnabled"]:checked')?.value !== 'no';
  const sound = soundEnabled
    ? (document.getElementById('alarmOptionsSound') as HTMLSelectElement).value as Alarm['sound']
    : 'none';
  if (!overlay || !dateInput || !messageInput || !hourInput || !minuteInput || !secondInput || !frequency || !notificationMode) return;
  const date = frequency === 'once' ? dateInput.value || undefined : undefined;
  const message = messageInput.value.trim() || undefined;
  const hour = Number(hourInput.value);
  const minute = Number(minuteInput.value);
  const second = Number(secondInput.value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) { alert('Enter a valid hour (0–23)'); return; }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) { alert('Enter valid minutes (0–59)'); return; }
  if (!Number.isInteger(second) || second < 0 || second > 59) { alert('Enter valid seconds (0–59)'); return; }
  const alarm = optionsAlarmId ? alarms.find(item => item.id === optionsAlarmId) : undefined;
  if (optionsAlarmId && !alarm) return;
  const recurring = frequency !== 'once';
  if (frequency !== 'hourly' && hasAlarmAtTime(hour, minute, second, alarm?.id, date, recurring)) {
    alert('An alarm is already set for this time!');
    return;
  }
  let scheduledAt: number | undefined;
  if (date && frequency !== 'hourly') {
    const [year, month, day] = date.split('-').map(Number);
    const targetTimestamp = alarmTime.zonedDateTimeToTimestamp(getEffectiveTimezoneForQuick(), { year, month, day, hour, minute, second });
    if (!Number.isFinite(targetTimestamp) || targetTimestamp <= Date.now()) {
      alert('Choose a future date and time.');
      return;
    }
    scheduledAt = targetTimestamp;
  }
  if (alarm) {
    const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
    if (!electronAPI) return;
    const previousExplicitDate = alarm.dateExplicit ? alarm.scheduledDate : undefined;
    const scheduleChanged = hour !== alarm.hour || minute !== alarm.minute || second !== alarm.second
      || frequency !== (alarm.frequency ?? (alarm.recurring ? 'daily' : 'once')) || date !== previousExplicitDate;
    const result = await electronAPI.updateAlarm({
      ...alarm, hour, minute, second, recurring, frequency, notificationMode, sound,
      dateExplicit: date !== undefined,
      scheduledDate: frequency === 'hourly' ? undefined : date, scheduledAt, message,
      completed: alarm.completed && !scheduleChanged ? true : undefined,
    });
    if (!result.ok) { alert(result.error ?? 'Could not update the alarm.'); return; }
  } else {
    const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
    if (!electronAPI) return;
    const result = await electronAPI.addAlarm({
      id: generateAlarmId(),
      hour,
      minute,
      second,
      enabled: true,
      recurring,
      frequency, notificationMode, sound,
      dateExplicit: date !== undefined,
      scheduledAt,
      scheduledDate: frequency === 'hourly' ? undefined : date,
      message,
    });
    if (!result.ok) { alert(result.error ?? 'Could not add the alarm.'); return; }
    hourInput.value = '00';
    minuteInput.value = '00';
    secondInput.value = '00';
    frequencyInputsReset();
    messageInput.value = '';
    pendingNewAlarmScheduledAt = undefined;
    pendingNewAlarmDate = undefined;
    pendingNewAlarmMessage = '';
  }
  overlay.classList.remove('modal-overlay--visible', 'show');
  optionsAlarmId = null;
  if (isStandaloneAddWindow) (window as any).electronAPI?.closeAlarmCreationWindow();
}

function getTimeUntilAlarm(alarm: Alarm): number {
  const tz = currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Math.floor((alarmTime.nextAlarmTimestamp(tz, alarm, Date.now()) - Date.now()) / 1000);
}

function formatTimeUntil(seconds: number): string {
  if (seconds <= 0) return 'Now';
  if (seconds < 60) return `in ${seconds}s`;
  
  const mins = Math.floor(seconds / 60);
  if (mins < 60) {
    return `in ${mins}m`;
  }
  
  const hours = Math.floor(seconds / 3600);
  const remainingMins = Math.floor((seconds % 3600) / 60);
  
  if (remainingMins === 0) {
    return `in ${hours}h`;
  }
  return `in ${hours}h ${remainingMins}m`;
}

function hasAlarmAtTime(
  hour: number,
  minute: number,
  second: number,
  excludeAlarmId?: string,
  scheduledDate?: string,
  recurring = false,
): boolean {
  return alarms.some(alarm => {
    // Ignore the alarm being updated.
    if (excludeAlarmId && alarm.id === excludeAlarmId) {
      return false;
    }
    if (alarm.hour !== hour || alarm.minute !== minute || alarm.second !== second) return false;
    const bothDateBoundOneShots = !alarm.recurring && !recurring
      && alarm.scheduledDate !== undefined && scheduledDate !== undefined;
    return bothDateBoundOneShots ? alarm.scheduledDate === scheduledDate : true;
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function renderAlarms(): void {
  const container = document.getElementById('alarmsList');
  if (!container) return;

  const sortTimeZone = currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sortNow = Date.now();

  const renderAlarm = (alarm: Alarm): string => {
    const scheduledLocalTime = alarm.scheduledAt === undefined
      ? null
      : getLocalTimeFromTimestamp(currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone, alarm.scheduledAt);
    const displayHour = scheduledLocalTime?.hour ?? alarm.hour;
    const displayMinute = scheduledLocalTime?.minute ?? alarm.minute;
    const displaySecond = scheduledLocalTime?.second ?? alarm.second;
    const timeStr = formatTime(displayHour, displayMinute, displaySecond);
    const baseDateStr = alarm.scheduledDate
      ? alarm.scheduledDate
      : dateInTimezone(currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          alarm.scheduledAt ?? alarmTime.nextAlarmTimestamp(currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone, alarm, Date.now()));
    const dateOnly = new Date(`${baseDateStr}T00:00:00Z`);
    const todayOnly = new Date(`${dateInTimezone(currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone, Date.now())}T00:00:00Z`);
    const dateDelta = Math.round((dateOnly.getTime() - todayOnly.getTime()) / 86400000);
    const relativeDate = dateDelta === 0 ? 'today' : dateDelta === 1 ? 'tomorrow' : dateDelta === -1 ? 'yesterday' : dateDelta > 1 ? `in ${dateDelta} days from now` : `${Math.abs(dateDelta)} days ago`;
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(dateOnly);
    const dateStr = `${baseDateStr} ${weekday} (${relativeDate})`;
    const frequency = alarm.frequency ?? (alarm.recurring ? 'daily' : 'once');
    const frequencyLabel = frequency === 'hourly' ? `Every hour at minute ${String(alarm.minute).padStart(2, '0')}` : frequency === 'daily' ? 'Every day' : 'Once';
    const notificationText = alarm.message?.trim();
    const notificationTextPreview = notificationText
      ? `${Array.from(notificationText).slice(0, 120).join('')}${Array.from(notificationText).length > 120 ? '…' : ''}`
      : '';
    const safeNotificationText = notificationText ? escapeHtml(notificationText) : '';
    const safeNotificationPreview = notificationTextPreview ? escapeHtml(notificationTextPreview) : '';
    const soundEnabled = alarm.sound !== 'none';
    
const timeUntil = alarm.enabled ? getTimeUntilAlarm(alarm) : 0;
const timeUntilStr = alarm.enabled ? formatTimeUntil(timeUntil) : '';

return `
  <div class="alarm-item list-group-item d-flex flex-wrap justify-content-between align-items-center gap-3" data-id="${alarm.id}">
    <div class="alarm-item__info d-flex flex-wrap align-items-center gap-3">
      <div class="alarm-item__time d-flex flex-column">
        <div class="alarm-item__time-header d-flex align-items-center justify-content-between gap-3">
          <span class="alarm-item__time-value fs-3 fw-bold font-monospace">${frequency === 'once' && alarm.completed ? `<del>${timeStr}</del>` : timeStr}</span>
          <div class="alarm-item__toggle form-check form-switch mb-0">
            <input type="checkbox" class="form-check-input" id="enable-${alarm.id}" ${alarm.enabled ? 'checked' : ''} onchange="toggleAlarm('${alarm.id}', this.checked)">
            <label class="form-check-label" for="enable-${alarm.id}">${alarm.enabled ? 'On' : 'Off'}</label>
          </div>
        </div>
        ${notificationText ? `<span class="alarm-item__message badge text-bg-light border fs-6 fw-normal text-wrap text-start" title="${safeNotificationText}">${safeNotificationPreview}</span>` : ''}
        <span class="alarm-item__frequency small text-body-secondary">${frequencyLabel}</span>
        <span class="alarm-item__sound small" role="img" aria-label="${soundEnabled ? 'Sound enabled' : 'Muted'}" title="${soundEnabled ? 'Sound enabled' : 'Muted'}"><i class="fa-solid ${soundEnabled ? 'fa-volume' : 'fa-volume-xmark'}" aria-hidden="true"></i></span>
        <span class="alarm-item__date badge ${alarm.completed ? 'text-bg-success' : 'text-bg-secondary'} align-self-start">${dateStr}${alarm.completed ? ' · Done' : ''}</span>
        ${alarm.enabled && timeUntilStr ? `<span class="alarm-item__countdown small text-body-secondary">${timeUntilStr}</span>` : ''}
      </div>
    </div>
    <div class="alarm-actions d-flex gap-2">
      <button class="alarm-actions__button--edit btn btn-outline-primary" onclick="editAlarm('${alarm.id}')">Edit</button>
      <button class="alarm-actions__button--delete btn btn-outline-danger" onclick="deleteAlarm('${alarm.id}')">Delete</button>
    </div>
  </div>
`;
  };

  if (alarms.length === 0) {
    container.innerHTML = '<div class="alarm-list__empty card shadow mb-4 p-3 text-center text-secondary">No alarms set</div>';
    return;
  }

  const groups: Array<{ frequency: 'once' | 'daily' | 'hourly'; title: string }> = [
    { frequency: 'once', title: 'Once' },
    { frequency: 'daily', title: 'Daily' },
    { frequency: 'hourly', title: 'Every Hour' },
  ];
  container.innerHTML = groups.map(group => {
    const groupAlarms = alarmListOrder.sortAlarmsForFrequency(
      alarms.filter(alarm => (alarm.frequency ?? (alarm.recurring ? 'daily' : 'once')) === group.frequency),
      group.frequency, sortTimeZone, sortNow,
    );
    if (groupAlarms.length === 0) return '';
    return `<section class="alarm-list__group card shadow mb-4">
      <div class="card-header bg-primary text-white"><h2 class="h5 mb-0">${group.title}</h2></div>
      <div class="list-group list-group-flush">${groupAlarms.map(renderAlarm).join('')}</div>
    </section>`;
  }).join('');


}

function updateAlarmCountdowns(): void {
  alarms.forEach(alarm => {
    const row = document.querySelector<HTMLElement>(`.alarm-item[data-id="${alarm.id}"]`);
    const timeBlock = row?.querySelector<HTMLElement>('.alarm-item__time');
    if (!row || !timeBlock) return;
    let countdown = timeBlock.querySelector<HTMLElement>('.alarm-item__countdown');
    if (!alarm.enabled) {
      countdown?.remove();
      return;
    }
    if (!countdown) {
      countdown = document.createElement('span');
      countdown.className = 'alarm-item__countdown small text-body-secondary';
      timeBlock.appendChild(countdown);
    }
    countdown.textContent = formatTimeUntil(getTimeUntilAlarm(alarm));
  });
}

function frequencyInputsReset(): void {
  const once = document.getElementById('alarmFrequencyOnce') as HTMLInputElement | null;
  if (once) once.checked = true;
}

function getEffectiveTimezoneForQuick(): string {
  return currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function editAlarm(alarmId: string): void {
  openAlarmOptions(alarmId);
}

async function deleteAlarm(alarmId: string): Promise<void> {
  if (!confirm('Are you sure you want to delete this alarm?')) {
    return;
  }

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (!electronAPI) return;
  const result = await electronAPI.deleteAlarm(alarmId);
  if (!result.ok) alert(result.error ?? 'Could not delete the alarm.');
}

async function toggleAlarm(alarmId: string, enabled: boolean): Promise<void> {
  const alarm = alarms.find(a => a.id === alarmId);
  if (!alarm) return;

  const updatedAlarm: Alarm = {
    ...alarm,
    enabled,
  };

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (!electronAPI) return;
  const result = await electronAPI.updateAlarm(updatedAlarm);
  if (!result.ok) {
    alert(result.error ?? 'Could not update the alarm.');
    renderAlarms();
    return;
  }
  alarms = alarms.map(item => item.id === alarmId ? { ...item, enabled } : item);
  renderAlarms();
}

function playAlarmSound(sound: string = 'classic'): void {
  // Create the alarm sound with the Web Audio API
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    audioContext = new AudioContextClass();

    function playBeep(): void {
      if (!audioContext) return;

      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = sound === 'digital' ? 1100 : sound === 'gentle' ? 520 : 800;
      oscillator.type = sound === 'digital' ? 'square' : 'sine';

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);
    }

    // Play the sound every 0.6 seconds
    isAlarmPlaying = true;
    playBeep();
    audioInterval = setInterval(() => {
      // Keep sounding until the alarm is explicitly dismissed.
      if (audioContext && isAlarmPlaying) {
        playBeep();
      } else {
        stopAlarmSound();
      }
    }, 600);
  } catch (e) {
    console.error('Could not play alarm sound:', e);
  }
}

function stopAlarmSound(): void {
  isAlarmPlaying = false;
  if (audioInterval) {
    clearInterval(audioInterval);
    audioInterval = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {
      // Ignore errors during close
    });
    audioContext = null;
  }
  updateDismissButton();
}

function updateDismissButton(): void {
  const dismissButton = document.getElementById('dismissAlarmBtn') as HTMLButtonElement | null;
  if (dismissButton) dismissButton.style.display = isAlarmTriggered ? 'inline-block' : 'none';
}

function dismissAlarm(): void {
  stopAlarmSound();
  isAlarmTriggered = false;
  ringingAlarmId = null;
  
  // Stop blinking the tray icon
  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.dismissAlarm();
  }
}

function clearPendingNewAlarm(): void {
  pendingNewAlarmScheduledAt = undefined;
  pendingNewAlarmDate = undefined;
  pendingNewAlarmMessage = '';
}

// Expose functions used by alarm list buttons.
(window as any).editAlarm = editAlarm;
(window as any).openAlarmOptions = openAlarmOptions;
(window as any).deleteAlarm = deleteAlarm;
(window as any).toggleAlarm = toggleAlarm;

// Initialize when the page loads
document.addEventListener('DOMContentLoaded', () => {
  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  const optionsOverlay = document.getElementById('alarmOptionsOverlay');
  document.getElementById('addAlarmBtn')?.addEventListener('click', () => {
    clearPendingNewAlarm();
    openAlarmOptions();
  });
  document.getElementById('alarmOptionsSaveBtn')?.addEventListener('click', saveAlarmOptions);
  document.querySelectorAll<HTMLButtonElement>('[data-reminder-seconds]').forEach(button => {
    button.addEventListener('click', () => {
      const seconds = Number(button.dataset.reminderSeconds);
      const target = Date.now() + seconds * 1000;
      pendingNewAlarmScheduledAt = target;
      pendingNewAlarmDate = dateInTimezone(getEffectiveTimezoneForQuick(), target);
      openAlarmOptions();
      const time = getLocalTimeFromTimestamp(getEffectiveTimezoneForQuick(), target);
      (document.getElementById('alarmOptionsHour') as HTMLInputElement).value = String(time.hour).padStart(2, '0');
      (document.getElementById('alarmOptionsMinute') as HTMLInputElement).value = String(time.minute).padStart(2, '0');
      (document.getElementById('alarmOptionsSecond') as HTMLInputElement).value = String(time.second).padStart(2, '0');
      (document.getElementById('alarmOptionsDate') as HTMLInputElement).value = pendingNewAlarmDate;
    });
  });
  document.querySelectorAll<HTMLAnchorElement>('[data-options-seconds], [data-options-minutes]').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      const seconds = Number(link.dataset.optionsSeconds ?? Number(link.dataset.optionsMinutes) * 60);
      const target = Date.now() + seconds * 1000;
      const time = getLocalTimeFromTimestamp(getEffectiveTimezoneForQuick(), target);
      (document.getElementById('alarmOptionsHour') as HTMLInputElement).value = String(time.hour).padStart(2, '0');
      (document.getElementById('alarmOptionsMinute') as HTMLInputElement).value = String(time.minute).padStart(2, '0');
      (document.getElementById('alarmOptionsSecond') as HTMLInputElement).value = String(time.second).padStart(2, '0');
      (document.getElementById('alarmOptionsDate') as HTMLInputElement).value = dateInTimezone(getEffectiveTimezoneForQuick(), target);
      const dateField = document.getElementById('alarmOptionsDateField');
      const setDateButton = document.getElementById('setAlarmDateBtn') as HTMLButtonElement | null;
      if (dateField) dateField.hidden = false;
      if (setDateButton) setDateButton.hidden = true;
    });
  });
  document.getElementById('alarmOptionsCancelBtn')?.addEventListener('click', () => {
    optionsOverlay?.classList.remove('modal-overlay--visible', 'show');
    optionsAlarmId = null;
    clearPendingNewAlarm();
    if (isStandaloneAddWindow) electronAPI?.closeAlarmCreationWindow();
  });
  optionsOverlay?.addEventListener('click', event => {
    if (event.target === optionsOverlay) {
      optionsOverlay.classList.remove('modal-overlay--visible', 'show');
      optionsAlarmId = null;
      clearPendingNewAlarm();
      if (isStandaloneAddWindow) electronAPI?.closeAlarmCreationWindow();
    }
  });
  if (electronAPI) {
    // Countdown window state
    electronAPI.onCountdownWindowState((visible: boolean) => {
      const btn = document.getElementById('countdownWindowBtn') as HTMLButtonElement;
      if (btn) {
        btn.textContent = visible ? 'Hide Countdown Window' : 'Show Countdown Window';
      }
    });

    // Display the current time and time zone in the main window
    electronAPI.getCurrentTimezone().then((info) => {
      currentTimezoneInfo = info;
      updateTimeTimezoneDisplay();
      renderAlarms();
      if (timeTimezoneInterval) clearTimeout(timeTimezoneInterval);
      const msUntilNextMinute = 60000 - (Date.now() % 60000);
      timeTimezoneInterval = setTimeout(() => {
        updateTimeTimezoneDisplay();
        timeTimezoneInterval = setInterval(updateTimeTimezoneDisplay, 60000);
      }, msUntilNextMinute);
      if (isStandaloneAddWindow) {
        clearPendingNewAlarm();
        const seconds = Number(new URLSearchParams(location.search).get('seconds'));
        if (Number.isFinite(seconds) && seconds > 0) {
          pendingNewAlarmScheduledAt = Date.now() + seconds * 1000;
          pendingNewAlarmDate = dateInTimezone(getEffectiveTimezoneForQuick(), pendingNewAlarmScheduledAt);
        }
        openAlarmOptions();
      }
    });

    // Request the alarm list
    electronAPI.getAllAlarms();

    // Listen for alarm updates
    electronAPI.onAlarmsUpdated((updatedAlarms) => {
      alarms = updatedAlarms;
      renderAlarms();
    });

    // Update only countdown labels so interactive alarm controls remain attached.
    if (timeUpdateInterval) {
      clearInterval(timeUpdateInterval);
    }
    timeUpdateInterval = setInterval(() => {
      updateAlarmCountdowns();
    }, 1000);

    // Listen for triggered alarms
    electronAPI.onAlarmTriggered((alarmId) => {
      const alarm = alarms.find(a => a.id === alarmId);
      if (alarm) {
        ringingAlarmId = alarmId;
        isAlarmTriggered = true;
        // Play the alarm sound
        if (alarm.sound !== 'none') playAlarmSound(alarm.sound ?? 'classic');
        updateDismissButton();
      }
    });

    // Listen for the main process closing a native notification
    electronAPI.onAlarmDismissFromMain(() => {
      stopAlarmSound();
      isAlarmTriggered = false;
      ringingAlarmId = null;
      updateDismissButton();
    });
  }

  document.getElementById('soundTestBtn')?.addEventListener('click', () => {
    const button = document.getElementById('soundTestBtn') as HTMLButtonElement;
    if (soundTestInterval) {
      clearInterval(soundTestInterval);
      soundTestInterval = null;
      stopAlarmSound();
      button.textContent = 'Test';
    } else {
      playAlarmSound((document.getElementById('alarmOptionsSound') as HTMLSelectElement).value);
      button.textContent = 'Stop';
      soundTestInterval = setTimeout(() => { soundTestInterval = null; stopAlarmSound(); button.textContent = 'Test'; }, 2500) as any;
    }
  });

  document.getElementById('previewAlarmBtn')?.addEventListener('click', async () => {
    const button = document.getElementById('previewAlarmBtn') as HTMLButtonElement;
    const hour = Number((document.getElementById('alarmOptionsHour') as HTMLInputElement).value);
    const minute = Number((document.getElementById('alarmOptionsMinute') as HTMLInputElement).value);
    const second = Number((document.getElementById('alarmOptionsSecond') as HTMLInputElement).value);
    const notificationMode = document.querySelector<HTMLInputElement>('input[name="notificationMode"]:checked')?.value as 'window' | 'system' | 'both' | undefined;
    const soundAllowed = document.querySelector<HTMLInputElement>('input[name="alarmSoundEnabled"]:checked')?.value !== 'no';
    const sound: 'classic' | 'digital' | 'gentle' | 'none' = soundAllowed
      ? (document.getElementById('alarmOptionsSound') as HTMLSelectElement).value as 'classic' | 'digital' | 'gentle'
      : 'none';
    const message = (document.getElementById('alarmOptionsMessage') as HTMLTextAreaElement).value.trim() || undefined;
    if (!notificationMode || !Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) {
      alert('Set a valid alarm time before previewing.');
      return;
    }
    button.disabled = true;
    try {
      const api = (window as any).electronAPI as ElectronAPI;
      const result = await api.previewAlarm({ notificationMode, message, sound, hour, minute, second });
      if (!result.ok) throw new Error(result.error || 'Could not preview the alarm.');
      if (sound !== 'none') {
        if (soundTestInterval) clearTimeout(soundTestInterval);
        stopAlarmSound();
        playAlarmSound(sound);
        soundTestInterval = setTimeout(() => { soundTestInterval = null; stopAlarmSound(); }, 2500) as any;
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not preview the alarm.');
    } finally {
      button.disabled = false;
    }
  });

  // Set up the app control buttons
  const countdownWindowBtn = document.getElementById('countdownWindowBtn');
  const minimizeBtn = document.getElementById('minimizeBtn');
  const closeBtn = document.getElementById('closeBtn');

  if (countdownWindowBtn) {
    countdownWindowBtn.addEventListener('click', () => {
      const api = (window as any).electronAPI as ElectronAPI | undefined;
      if (api) api.toggleCountdownWindow();
    });
  }

  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', () => {
      const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
      if (electronAPI) {
        electronAPI.minimizeWindow();
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
      electronAPI?.closeApp();
    });
  }

  document.getElementById('settingsBtn')?.addEventListener('click', () => {
    const api = (window as any).electronAPI as ElectronAPI | undefined;
    api?.openSettingsWindow();
  });

  // Handle the Dismiss Alarm button
  const dismissBtn = document.getElementById('dismissAlarmBtn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', dismissAlarm);
  }

  electronAPI?.onTimezoneUpdated(info => {
    currentTimezoneInfo = info;
    updateTimeTimezoneDisplay();
    renderAlarms();
  });
});

