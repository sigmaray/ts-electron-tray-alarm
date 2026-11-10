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
  sound?: 'classic' | 'digital' | 'gentle';
  scheduledAt?: number;
  scheduledDate?: string;
  message?: string;
  completed?: boolean;
}

interface ElectronAPI {
  minimizeWindow: () => void;
  closeApp: () => void;
  addAlarm: (alarm: Alarm) => Promise<{ ok: boolean; error?: string }>;
  updateAlarm: (alarm: Alarm) => Promise<{ ok: boolean; error?: string }>;
  deleteAlarm: (alarmId: string) => Promise<{ ok: boolean; error?: string }>;
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
  setTimezone: (tz: string | null) => Promise<{ effective: string; isSystem: boolean }>;
}

let alarms: Alarm[] = [];
let audioContext: AudioContext | null = null;
let audioInterval: NodeJS.Timeout | null = null;
let isAlarmPlaying: boolean = false;
let isAlarmTriggered = false;
let soundTestInterval: ReturnType<typeof setInterval> | null = null;
let timeUpdateInterval: NodeJS.Timeout | null = null;
let currentTimezoneInfo: { effective: string; isSystem: boolean } | null = null;
let timeTimezoneInterval: ReturnType<typeof setInterval> | null = null;
let pendingNewAlarmScheduledAt: number | undefined;
let pendingNewAlarmDate: string | undefined;
let pendingNewAlarmMessage = '';
let ringingAlarmId: string | null = null;
let optionsAlarmId: string | null = null;
const alarmTime = (window as any).AlarmTime;

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
  const frequencyInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="alarmFrequency"]'));
  const soundInput = document.getElementById('alarmOptionsSound') as HTMLSelectElement | null;
  if (!overlay || !dateInput || !messageInput || !hourInput || !minuteInput || !secondInput) return;
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
    dateInput.value = alarm.scheduledDate ?? (alarm.scheduledAt === undefined ? '' : dateInTimezone(tz, alarm.scheduledAt));
    messageInput.value = alarm.message ?? '';
    if (soundInput) soundInput.value = alarm.sound ?? 'classic';
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
    messageInput.value = pendingNewAlarmMessage;
    if (soundInput) soundInput.value = 'classic';
    (document.getElementById('notificationWindow') as HTMLInputElement).checked = true;
    document.getElementById('alarmOptionsTitle')!.textContent = 'Add alarm';
  }
  const updateHourlyLabel = () => { document.getElementById('hourlyMinuteLabel')!.textContent = minuteInput.value.padStart(2, '0'); };
  minuteInput.oninput = updateHourlyLabel;
  updateHourlyLabel();
  const updateFrequencyFields = () => {
    const hourly = frequencyInputs.find(input => input.checked)?.value === 'hourly';
    dateInput.disabled = hourly;
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
  const sound = (document.getElementById('alarmOptionsSound') as HTMLSelectElement).value as Alarm['sound'];
  if (!overlay || !dateInput || !messageInput || !hourInput || !minuteInput || !secondInput || !frequency || !notificationMode) return;
  const date = dateInput.value || undefined;
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
    const scheduleChanged = hour !== alarm.hour || minute !== alarm.minute || second !== alarm.second
      || frequency !== (alarm.frequency ?? (alarm.recurring ? 'daily' : 'once')) || date !== alarm.scheduledDate;
    const result = await electronAPI.updateAlarm({
      ...alarm, hour, minute, second, recurring, frequency, notificationMode, sound,
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

function renderAlarms(): void {
  const container = document.getElementById('alarmsList');
  if (!container) return;

  if (alarms.length === 0) {
    container.innerHTML = '<div class="alarm-list__empty list-group-item text-center text-secondary">No alarms set</div>';
    return;
  }

  // Sort alarms by time
  const sortedAlarms = [...alarms].sort((a, b) => {
    if (a.hour !== b.hour) return a.hour - b.hour;
    if (a.minute !== b.minute) return a.minute - b.minute;
    return a.second - b.second;
  });

  container.innerHTML = sortedAlarms.map(alarm => {
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
    
const timeUntil = alarm.enabled ? getTimeUntilAlarm(alarm) : 0;
const timeUntilStr = alarm.enabled ? formatTimeUntil(timeUntil) : '';

return `
  <div class="alarm-item list-group-item d-flex flex-wrap justify-content-between align-items-center gap-3" data-id="${alarm.id}">
    <div class="alarm-item__info d-flex flex-wrap align-items-center gap-3">
      <div class="alarm-item__time d-flex flex-column">
        <span class="alarm-item__time-value fs-3 fw-bold font-monospace">${timeStr}</span>
        <span class="alarm-item__frequency small text-body-secondary">${frequencyLabel}</span>
        <span class="alarm-item__date badge ${alarm.completed ? 'text-bg-success' : 'text-bg-secondary'} align-self-start">${dateStr}${alarm.completed ? ' · Done' : ''}</span>
        ${alarm.enabled && timeUntilStr ? `<span class="alarm-item__countdown small text-body-secondary">${timeUntilStr}</span>` : ''}
      </div>
      <div class="alarm-item__toggles d-flex flex-wrap gap-3">
        <div class="alarm-item__toggle form-check form-switch">
            <input type="checkbox" class="form-check-input" id="enable-${alarm.id}" ${alarm.enabled ? 'checked' : ''} onchange="toggleAlarm('${alarm.id}', this.checked)">
            <label class="form-check-label" for="enable-${alarm.id}">On</label>
        </div>
      </div>
    </div>
    <div class="alarm-actions d-flex gap-2">
      <button class="alarm-actions__button--edit btn btn-outline-primary" onclick="editAlarm('${alarm.id}')">Edit</button>
      <button class="alarm-actions__button--delete btn btn-outline-danger" onclick="deleteAlarm('${alarm.id}')">Delete</button>
    </div>
  </div>
`;
  }).join('');


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
  if (!result.ok) { alert(result.error ?? 'Could not update the alarm.'); renderAlarms(); }
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

// Expose functions used by alarm list buttons.
(window as any).editAlarm = editAlarm;
(window as any).openAlarmOptions = openAlarmOptions;
(window as any).deleteAlarm = deleteAlarm;
(window as any).toggleAlarm = toggleAlarm;

// Initialize when the page loads
document.addEventListener('DOMContentLoaded', () => {
  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  const optionsOverlay = document.getElementById('alarmOptionsOverlay');
  document.getElementById('addAlarmBtn')?.addEventListener('click', () => openAlarmOptions());
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
    });
  });
  document.getElementById('alarmOptionsCancelBtn')?.addEventListener('click', () => {
    optionsOverlay?.classList.remove('modal-overlay--visible', 'show');
    optionsAlarmId = null;
  });
  optionsOverlay?.addEventListener('click', event => {
    if (event.target === optionsOverlay) {
      optionsOverlay.classList.remove('modal-overlay--visible', 'show');
      optionsAlarmId = null;
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
      if (timeTimezoneInterval) clearInterval(timeTimezoneInterval);
      timeTimezoneInterval = setInterval(updateTimeTimezoneDisplay, 60000);
    });

    // Request the alarm list
    electronAPI.getAllAlarms();

    // Listen for alarm updates
    electronAPI.onAlarmsUpdated((updatedAlarms) => {
      alarms = updatedAlarms;
      renderAlarms();
    });

    // Update alarm countdowns every second
    if (timeUpdateInterval) {
      clearInterval(timeUpdateInterval);
    }
    timeUpdateInterval = setInterval(() => {
      // If an alarm is being edited, update only its countdown
      // Avoid a full rerender so focus is preserved
      renderAlarms();
    }, 1000);

    // Listen for triggered alarms
    electronAPI.onAlarmTriggered((alarmId) => {
      const alarm = alarms.find(a => a.id === alarmId);
      if (alarm) {
        ringingAlarmId = alarmId;
        isAlarmTriggered = true;
        // Play the alarm sound
        playAlarmSound(alarm.sound ?? 'classic');
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
      const confirmed = confirm('Are you sure you want to quit the application?');
      if (confirmed) {
        const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
        if (electronAPI) {
          electronAPI.closeApp();
        }
      }
    });
  }

  // Handle the Dismiss Alarm button
  const dismissBtn = document.getElementById('dismissAlarmBtn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', dismissAlarm);
  }

  // Time zone selection dialog
  const timezoneBtn = document.getElementById('timezoneBtn');
  const timezoneModalOverlay = document.getElementById('timezoneModalOverlay');
  const timezoneList = document.getElementById('timezoneList') as HTMLSelectElement | null;
  const timezoneCurrentLabel = document.getElementById('timezoneCurrentLabel');
  const timezoneSaveBtn = document.getElementById('timezoneSaveBtn');
  const timezoneCancelBtn = document.getElementById('timezoneCancelBtn');

  let allTimezones: string[] = [];
  let selectedTimezoneValue: string | null = null;

  function renderTimezoneOptions(): void {
    if (!timezoneList) return;
    timezoneList.replaceChildren(new Option('System time zone (default)', ''));
    const timezones = selectedTimezoneValue && !allTimezones.includes(selectedTimezoneValue)
      ? [...allTimezones, selectedTimezoneValue].sort()
      : allTimezones;
    timezones.forEach(timezone => timezoneList.add(new Option(timezone, timezone)));
    timezoneList.value = selectedTimezoneValue ?? '';
  }

  if (timezoneBtn && timezoneModalOverlay && electronAPI) {
    timezoneBtn.addEventListener('click', async () => {
      const { effective, isSystem } = await electronAPI.getCurrentTimezone();
      timezoneCurrentLabel!.textContent = isSystem
        ? `Current: System time zone (${effective})`
        : 'Current: ' + effective;
      selectedTimezoneValue = isSystem ? null : effective;
      if (allTimezones.length === 0) {
        allTimezones = await electronAPI.getTimezones();
        allTimezones.sort();
      }
      renderTimezoneOptions();
      if (timezoneList) {
        timezoneList.onchange = () => {
          selectedTimezoneValue = timezoneList.value || null;
        };
      }
      timezoneModalOverlay.classList.add('modal-overlay--visible', 'show');
      timezoneList?.focus();
    });
  }

  if (timezoneSaveBtn && timezoneModalOverlay && electronAPI) {
    timezoneSaveBtn.addEventListener('click', async () => {
      const { effective, isSystem } = await electronAPI.setTimezone(selectedTimezoneValue);
      currentTimezoneInfo = { effective, isSystem };
      updateTimeTimezoneDisplay();
      renderAlarms();
      timezoneCurrentLabel!.textContent = isSystem
        ? `Current: System time zone (${effective})`
        : 'Current: ' + effective;
      timezoneModalOverlay.classList.remove('modal-overlay--visible', 'show');
    });
  }

  if (timezoneCancelBtn && timezoneModalOverlay) {
    timezoneCancelBtn.addEventListener('click', () => {
      timezoneModalOverlay.classList.remove('modal-overlay--visible', 'show');
    });
  }

  if (timezoneModalOverlay) {
    timezoneModalOverlay.addEventListener('click', (e) => {
      if (e.target === timezoneModalOverlay) {
        timezoneModalOverlay.classList.remove('modal-overlay--visible', 'show');
      }
    });
  }
});

