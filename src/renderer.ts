// Types for the Electron API
interface Alarm {
  id: string;
  hour: number;
  minute: number;
  second: number;
  enabled: boolean;
  recurring: boolean;
  scheduledAt?: number;
  scheduledDate?: string;
  message?: string;
}

interface ElectronAPI {
  minimizeWindow: () => void;
  closeApp: () => void;
  addAlarm: (alarm: Alarm) => void;
  updateAlarm: (alarm: Alarm) => void;
  deleteAlarm: (alarmId: string) => void;
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
let editingAlarmId: string | null = null;
let audioContext: AudioContext | null = null;
let audioInterval: NodeJS.Timeout | null = null;
let isAlarmPlaying: boolean = false;
let alarmNotification: Notification | null = null;
let notificationCheckInterval: NodeJS.Timeout | null = null;
let timeUpdateInterval: NodeJS.Timeout | null = null;
let currentTimezoneInfo: { effective: string; isSystem: boolean } | null = null;
let timeTimezoneInterval: ReturnType<typeof setInterval> | null = null;
let pendingNewAlarmScheduledAt: number | undefined;
let pendingEditScheduledAt: number | undefined;
let pendingNewAlarmDate: string | undefined;
let pendingNewAlarmMessage = '';
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
  const recurringInput = document.getElementById('alarmOptionsRecurring') as HTMLInputElement | null;
  if (!overlay || !dateInput || !messageInput || !hourInput || !minuteInput || !secondInput || !recurringInput) return;
  optionsAlarmId = alarmId ?? null;
  const tz = getEffectiveTimezoneForQuick();
  if (alarmId) {
    const alarm = alarms.find(item => item.id === alarmId);
    if (!alarm) return;
    const time = alarm.scheduledAt === undefined ? alarm : getLocalTimeFromTimestamp(tz, alarm.scheduledAt);
    hourInput.value = String(time.hour).padStart(2, '0');
    minuteInput.value = String(time.minute).padStart(2, '0');
    secondInput.value = String(time.second).padStart(2, '0');
    recurringInput.checked = alarm.recurring;
    dateInput.value = alarm.scheduledDate ?? (alarm.scheduledAt === undefined ? '' : dateInTimezone(tz, alarm.scheduledAt));
    messageInput.value = alarm.message ?? '';
  } else {
    hourInput.value = (document.getElementById('newHour') as HTMLInputElement).value;
    minuteInput.value = (document.getElementById('newMinute') as HTMLInputElement).value;
    secondInput.value = (document.getElementById('newSecond') as HTMLInputElement).value;
    recurringInput.checked = (document.getElementById('newRecurring') as HTMLInputElement).checked;
    dateInput.value = pendingNewAlarmDate ?? (pendingNewAlarmScheduledAt === undefined ? '' : dateInTimezone(tz, pendingNewAlarmScheduledAt));
    messageInput.value = pendingNewAlarmMessage;
  }
  overlay.classList.add('modal-overlay--visible', 'show');
  dateInput.focus();
}

function saveAlarmOptions(): void {
  const overlay = document.getElementById('alarmOptionsOverlay');
  const dateInput = document.getElementById('alarmOptionsDate') as HTMLInputElement | null;
  const messageInput = document.getElementById('alarmOptionsMessage') as HTMLTextAreaElement | null;
  const hourInput = document.getElementById('alarmOptionsHour') as HTMLInputElement | null;
  const minuteInput = document.getElementById('alarmOptionsMinute') as HTMLInputElement | null;
  const secondInput = document.getElementById('alarmOptionsSecond') as HTMLInputElement | null;
  const recurringInput = document.getElementById('alarmOptionsRecurring') as HTMLInputElement | null;
  if (!overlay || !dateInput || !messageInput || !hourInput || !minuteInput || !secondInput || !recurringInput) return;
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
  if (hasAlarmAtTime(hour, minute, second, alarm?.id)) {
    alert('An alarm is already set for this time!');
    return;
  }
  let scheduledAt: number | undefined;
  if (date) {
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
    electronAPI?.updateAlarm({ ...alarm, hour, minute, second, recurring: recurringInput.checked, scheduledDate: date, scheduledAt, message });
  } else {
    const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
    electronAPI?.addAlarm({
      id: generateAlarmId(),
      hour,
      minute,
      second,
      enabled: true,
      recurring: recurringInput.checked,
      scheduledAt,
      scheduledDate: date,
      message,
    });
    (document.getElementById('newHour') as HTMLInputElement).value = '00';
    (document.getElementById('newMinute') as HTMLInputElement).value = '00';
    (document.getElementById('newSecond') as HTMLInputElement).value = '00';
    (document.getElementById('newRecurring') as HTMLInputElement).checked = false;
    hourInput.value = '00';
    minuteInput.value = '00';
    secondInput.value = '00';
    recurringInput.checked = false;
    dateInput.value = '';
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

function hasAlarmAtTime(hour: number, minute: number, second: number, excludeAlarmId?: string): boolean {
  return alarms.some(alarm => {
    // Skip the alarm currently being edited
    if (excludeAlarmId && alarm.id === excludeAlarmId) {
      return false;
    }
    return alarm.hour === hour && alarm.minute === minute && alarm.second === second;
  });
}

function updateTimeUntilForAlarms(): void {
  // Update countdowns only for alarms that are not being edited
  alarms.forEach(alarm => {
    if (alarm.id === editingAlarmId) return; // Skip the alarm currently being edited
    
    const alarmItem = document.querySelector(`.alarm-item[data-id="${alarm.id}"]`);
    if (!alarmItem) return;
    
    const timeUntilElement = alarmItem.querySelector('.alarm-item__countdown');
    if (alarm.enabled) {
      const timeUntil = getTimeUntilAlarm(alarm);
      const timeUntilStr = formatTimeUntil(timeUntil);
      
      if (timeUntilElement) {
        timeUntilElement.textContent = timeUntilStr;
      } else {
        // Add the countdown element if the alarm is enabled and it is missing
        const timeGroup = alarmItem.querySelector('.alarm-item__time');
        if (timeGroup) {
          const timeUntilSpan = document.createElement('span');
          timeUntilSpan.className = 'alarm-item__countdown';
          timeUntilSpan.textContent = timeUntilStr;
          timeGroup.appendChild(timeUntilSpan);
        }
      }
    } else {
      // Remove the countdown when the alarm is disabled
      if (timeUntilElement) {
        timeUntilElement.remove();
      }
    }
  });
}

function setupTimeInputHandlers(input: HTMLInputElement): void {
  // Avoid registering duplicate handlers by checking the data property
  if ((input as any).__timeHandlersSetup) {
    return; // Handlers are already registered
  }
  
  // Clear the field on focus when its value is "0" or "00"
  input.addEventListener('input', () => {
    if (input.id.startsWith('edit-')) pendingEditScheduledAt = undefined;
    else pendingNewAlarmScheduledAt = undefined;
  });

  input.addEventListener('focus', function focusHandler() {
    if (this.value === '0' || this.value === '00') {
      this.value = '';
    }
  });
  
  // Set the value to "0" on blur if the field is empty
  input.addEventListener('blur', function blurHandler() {
    if (this.value === '' || this.value.trim() === '') {
      this.value = '0';
    }
  });
  
  // Mark the handlers as registered
  (input as any).__timeHandlersSetup = true;
}

function renderAlarms(): void {
  const container = document.getElementById('alarmsList');
  if (!container) return;

  // Save edit field values and focus before rerendering
  let editingValues: { hour: string; minute: string; second: string; focusedField: string | null } | null = null;
  if (editingAlarmId) {
    const hourInput = document.getElementById(`edit-hour-${editingAlarmId}`) as HTMLInputElement;
    const minuteInput = document.getElementById(`edit-minute-${editingAlarmId}`) as HTMLInputElement;
    const secondInput = document.getElementById(`edit-second-${editingAlarmId}`) as HTMLInputElement;
    
    if (hourInput && minuteInput && secondInput) {
      // Find which field has focus
      let focusedField: string | null = null;
      if (document.activeElement === hourInput) {
        focusedField = 'hour';
      } else if (document.activeElement === minuteInput) {
        focusedField = 'minute';
      } else if (document.activeElement === secondInput) {
        focusedField = 'second';
      }
      
      // Save the cursor position
      const activeElement = document.activeElement as HTMLInputElement;
      const cursorPosition = activeElement && (activeElement === hourInput || activeElement === minuteInput || activeElement === secondInput) 
        ? activeElement.selectionStart 
        : null;
      
      editingValues = {
        hour: hourInput.value,
        minute: minuteInput.value,
        second: secondInput.value,
        focusedField: focusedField,
        cursorPosition: cursorPosition
      } as any;
    }
  }

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
    const isEditing = editingAlarmId === alarm.id;
    const scheduledLocalTime = alarm.scheduledAt === undefined
      ? null
      : getLocalTimeFromTimestamp(currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone, alarm.scheduledAt);
    const displayHour = scheduledLocalTime?.hour ?? alarm.hour;
    const displayMinute = scheduledLocalTime?.minute ?? alarm.minute;
    const displaySecond = scheduledLocalTime?.second ?? alarm.second;
    const timeStr = formatTime(displayHour, displayMinute, displaySecond);
    const dateTimestamp = alarm.scheduledAt ?? alarmTime.nextAlarmTimestamp(currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone, alarm, Date.now());
    const dateLocal = alarmTime.localDateTimeInTimezone(currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone, dateTimestamp);
    const dateStr = `${dateLocal.year}-${String(dateLocal.month).padStart(2, '0')}-${String(dateLocal.day).padStart(2, '0')}`;
    
    if (isEditing) {
      // Use saved field values when available, otherwise use the alarm values
      const hourValue = editingValues ? editingValues.hour : displayHour;
      const minuteValue = editingValues ? editingValues.minute : displayMinute;
      const secondValue = editingValues ? editingValues.second : displaySecond;
      
      return `
        <div class="alarm-item alarm-item--editing list-group-item d-flex flex-column align-items-stretch gap-3" data-id="${alarm.id}">
          <div class="alarm-item__time-editor input-group input-group-sm justify-content-center">
            <input type="number" min="0" max="23" value="${hourValue}" class="alarm-item__time-input alarm-item__time-input--hour form-control" id="edit-hour-${alarm.id}">
            <span class="alarm-item__time-separator input-group-text">:</span>
            <input type="number" min="0" max="59" value="${minuteValue}" class="alarm-item__time-input alarm-item__time-input--minute form-control" id="edit-minute-${alarm.id}">
            <span class="alarm-item__time-separator input-group-text">:</span>
            <input type="number" min="0" max="59" value="${secondValue}" class="alarm-item__time-input alarm-item__time-input--second form-control" id="edit-second-${alarm.id}">
          </div>
          <div class="quick-time d-flex flex-wrap justify-content-center gap-2">
            <a href="#" class="quick-time__link btn btn-sm btn-outline-secondary" onclick="setQuickTimeSecondsForEdit('${alarm.id}', 30); return false;">in 30 seconds</a>
            <a href="#" class="quick-time__link btn btn-sm btn-outline-secondary" onclick="setQuickTimeSecondsForEdit('${alarm.id}', 60); return false;">in 1 minute</a>
            <a href="#" class="quick-time__link btn btn-sm btn-outline-secondary" onclick="setQuickTimeForEdit('${alarm.id}', 2); return false;">in 2 minutes</a>
            <a href="#" class="quick-time__link btn btn-sm btn-outline-secondary" onclick="setQuickTimeForEdit('${alarm.id}', 5); return false;">in 5 minutes</a>
            <a href="#" class="quick-time__link btn btn-sm btn-outline-secondary" onclick="setQuickTimeForEdit('${alarm.id}', 30); return false;">in 30 minutes</a>
            <a href="#" class="quick-time__link btn btn-sm btn-outline-secondary" onclick="setQuickTimeForEdit('${alarm.id}', 60); return false;">in 1 hour</a>
            <a href="#" class="quick-time__link btn btn-sm btn-outline-secondary" onclick="setQuickTimeForEdit('${alarm.id}', 120); return false;">in 2 hours</a>
          </div>
          <div class="alarm-actions d-flex justify-content-end gap-2">
            <button class="alarm-actions__button--save btn btn-success" onclick="saveAlarm('${alarm.id}')">Save</button>
            <button class="alarm-actions__button--cancel btn btn-secondary" onclick="cancelEdit('${alarm.id}')">Cancel</button>
          </div>
        </div>
      `;
    } else {
      const timeUntil = alarm.enabled ? getTimeUntilAlarm(alarm) : 0;
      const timeUntilStr = alarm.enabled ? formatTimeUntil(timeUntil) : '';
      
      return `
        <div class="alarm-item list-group-item d-flex flex-wrap justify-content-between align-items-center gap-3" data-id="${alarm.id}">
          <div class="alarm-item__info d-flex flex-wrap align-items-center gap-3">
            <div class="alarm-item__time d-flex flex-column">
              <span class="alarm-item__time-value fs-3 fw-bold font-monospace">${timeStr}</span>
              <span class="alarm-item__date badge text-bg-secondary align-self-start">${dateStr}</span>
              ${alarm.enabled && timeUntilStr ? `<span class="alarm-item__countdown small text-body-secondary">${timeUntilStr}</span>` : ''}
            </div>
            <div class="alarm-item__toggles d-flex flex-wrap gap-3">
              <div class="alarm-item__toggle form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="enable-${alarm.id}" ${alarm.enabled ? 'checked' : ''} onchange="toggleAlarm('${alarm.id}', this.checked)">
                  <label class="form-check-label" for="enable-${alarm.id}">On</label>
              </div>
              <div class="alarm-item__toggle form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="repeat-${alarm.id}" ${alarm.recurring ? 'checked' : ''} onchange="toggleRecurring('${alarm.id}', this.checked)">
                  <label class="form-check-label" for="repeat-${alarm.id}">Repeat</label>
              </div>
            </div>
          </div>
          <div class="alarm-actions d-flex gap-2">
            <button class="alarm-actions__options btn btn-outline-secondary" aria-label="More options" onclick="openAlarmOptions('${alarm.id}')">...</button>
            <button class="alarm-actions__button--edit btn btn-outline-primary" onclick="editAlarm('${alarm.id}')">Edit</button>
            <button class="alarm-actions__button--delete btn btn-outline-danger" onclick="deleteAlarm('${alarm.id}')">Delete</button>
          </div>
        </div>
      `;
    }
  }).join('');

  // Restore focus and cursor position after rerendering
  if (editingAlarmId && editingValues && editingValues.focusedField) {
    setTimeout(() => {
      let inputToFocus: HTMLInputElement | null = null;
      if (editingValues!.focusedField === 'hour') {
        inputToFocus = document.getElementById(`edit-hour-${editingAlarmId}`) as HTMLInputElement;
      } else if (editingValues!.focusedField === 'minute') {
        inputToFocus = document.getElementById(`edit-minute-${editingAlarmId}`) as HTMLInputElement;
      } else if (editingValues!.focusedField === 'second') {
        inputToFocus = document.getElementById(`edit-second-${editingAlarmId}`) as HTMLInputElement;
      }
      
      if (inputToFocus) {
        // Set up handlers for the edit fields
        setupTimeInputHandlers(inputToFocus);
        inputToFocus.focus();
        // Restore the cursor position
        const cursorPos = (editingValues as any).cursorPosition;
        if (cursorPos !== null && cursorPos !== undefined) {
          inputToFocus.setSelectionRange(cursorPos, cursorPos);
        }
      }
      
      // Set up handlers for all edit fields
      const hourInput = document.getElementById(`edit-hour-${editingAlarmId}`) as HTMLInputElement;
      const minuteInput = document.getElementById(`edit-minute-${editingAlarmId}`) as HTMLInputElement;
      const secondInput = document.getElementById(`edit-second-${editingAlarmId}`) as HTMLInputElement;
      
      if (hourInput) setupTimeInputHandlers(hourInput);
      if (minuteInput) setupTimeInputHandlers(minuteInput);
      if (secondInput) setupTimeInputHandlers(secondInput);
    }, 0);
  }
}

function getEffectiveTimezoneForQuick(): string {
  return currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function setQuickTime(minutes: number): void {
  const hourInput = document.getElementById('newHour') as HTMLInputElement;
  const minuteInput = document.getElementById('newMinute') as HTMLInputElement;
  const secondInput = document.getElementById('newSecond') as HTMLInputElement;
  
  if (!hourInput || !minuteInput || !secondInput) return;

  const tz = getEffectiveTimezoneForQuick();
  const futureTs = Date.now() + minutes * 60 * 1000;
  pendingNewAlarmScheduledAt = futureTs;
  const { hour, minute, second } = getLocalTimeFromTimestamp(tz, futureTs);

  hourInput.value = String(hour).padStart(2, '0');
  minuteInput.value = String(minute).padStart(2, '0');
  secondInput.value = String(second).padStart(2, '0');
}

function setQuickTimeSeconds(seconds: number): void {
  const hourInput = document.getElementById('newHour') as HTMLInputElement;
  const minuteInput = document.getElementById('newMinute') as HTMLInputElement;
  const secondInput = document.getElementById('newSecond') as HTMLInputElement;
  
  if (!hourInput || !minuteInput || !secondInput) return;

  const tz = getEffectiveTimezoneForQuick();
  const futureTs = Date.now() + seconds * 1000;
  pendingNewAlarmScheduledAt = futureTs;
  const { hour, minute, second } = getLocalTimeFromTimestamp(tz, futureTs);

  hourInput.value = String(hour).padStart(2, '0');
  minuteInput.value = String(minute).padStart(2, '0');
  secondInput.value = String(second).padStart(2, '0');
}

function setQuickTimeForEdit(alarmId: string, minutes: number): void {
  const hourInput = document.getElementById(`edit-hour-${alarmId}`) as HTMLInputElement;
  const minuteInput = document.getElementById(`edit-minute-${alarmId}`) as HTMLInputElement;
  const secondInput = document.getElementById(`edit-second-${alarmId}`) as HTMLInputElement;
  
  if (!hourInput || !minuteInput || !secondInput) return;

  const tz = getEffectiveTimezoneForQuick();
  const futureTs = Date.now() + minutes * 60 * 1000;
  pendingEditScheduledAt = futureTs;
  const { hour, minute, second } = getLocalTimeFromTimestamp(tz, futureTs);

  hourInput.value = String(hour).padStart(2, '0');
  minuteInput.value = String(minute).padStart(2, '0');
  secondInput.value = String(second).padStart(2, '0');
}

function setQuickTimeSecondsForEdit(alarmId: string, seconds: number): void {
  const hourInput = document.getElementById(`edit-hour-${alarmId}`) as HTMLInputElement;
  const minuteInput = document.getElementById(`edit-minute-${alarmId}`) as HTMLInputElement;
  const secondInput = document.getElementById(`edit-second-${alarmId}`) as HTMLInputElement;
  
  if (!hourInput || !minuteInput || !secondInput) return;

  const tz = getEffectiveTimezoneForQuick();
  const futureTs = Date.now() + seconds * 1000;
  pendingEditScheduledAt = futureTs;
  const { hour, minute, second } = getLocalTimeFromTimestamp(tz, futureTs);

  hourInput.value = String(hour).padStart(2, '0');
  minuteInput.value = String(minute).padStart(2, '0');
  secondInput.value = String(second).padStart(2, '0');
}

function addAlarm(): void {
  const hourInput = document.getElementById('newHour') as HTMLInputElement;
  const minuteInput = document.getElementById('newMinute') as HTMLInputElement;
  const secondInput = document.getElementById('newSecond') as HTMLInputElement;
  
  if (!hourInput || !minuteInput || !secondInput) return;

  const hour = parseInt(hourInput.value, 10);
  const minute = parseInt(minuteInput.value, 10);
  const second = parseInt(secondInput.value, 10);

  if (isNaN(hour) || hour < 0 || hour > 23) {
    alert('Enter a valid hour (0–23)');
    return;
  }

  if (isNaN(minute) || minute < 0 || minute > 59) {
    alert('Enter valid minutes (0–59)');
    return;
  }

  if (isNaN(second) || second < 0 || second > 59) {
    alert('Enter valid seconds (0–59)');
    return;
  }

  // Check whether an alarm already exists at this time
  if (hasAlarmAtTime(hour, minute, second)) {
    alert('An alarm is already set for this time!');
    return;
  }

  const recurringInput = document.getElementById('newRecurring') as HTMLInputElement;
  const recurring = recurringInput ? recurringInput.checked : false;

  const newAlarm: Alarm = {
    id: generateAlarmId(),
    hour,
    minute,
    second,
    enabled: true,
    recurring,
    scheduledAt: pendingNewAlarmScheduledAt,
    scheduledDate: pendingNewAlarmDate,
    message: pendingNewAlarmMessage.trim() || undefined,
  };

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.addAlarm(newAlarm);
  }

  // Reset the input fields
  hourInput.value = '00';
  minuteInput.value = '00';
  secondInput.value = '00';
  if (recurringInput) {
    recurringInput.checked = false;
  }
  pendingNewAlarmScheduledAt = undefined;
  pendingNewAlarmDate = undefined;
  pendingNewAlarmMessage = '';
}

function editAlarm(alarmId: string): void {
  editingAlarmId = alarmId;
  pendingEditScheduledAt = alarms.find(alarm => alarm.id === alarmId)?.scheduledAt;
  renderAlarms();
  
  // Set up handlers for the edit fields after rerendering
  setTimeout(() => {
    const hourInput = document.getElementById(`edit-hour-${alarmId}`) as HTMLInputElement;
    const minuteInput = document.getElementById(`edit-minute-${alarmId}`) as HTMLInputElement;
    const secondInput = document.getElementById(`edit-second-${alarmId}`) as HTMLInputElement;
    
    if (hourInput) setupTimeInputHandlers(hourInput);
    if (minuteInput) setupTimeInputHandlers(minuteInput);
    if (secondInput) setupTimeInputHandlers(secondInput);
  }, 0);
}

function cancelEdit(alarmId: string): void {
  editingAlarmId = null;
  pendingEditScheduledAt = undefined;
  renderAlarms();
}

function saveAlarm(alarmId: string): void {
  const hourInput = document.getElementById(`edit-hour-${alarmId}`) as HTMLInputElement;
  const minuteInput = document.getElementById(`edit-minute-${alarmId}`) as HTMLInputElement;
  const secondInput = document.getElementById(`edit-second-${alarmId}`) as HTMLInputElement;

  if (!hourInput || !minuteInput || !secondInput) return;

  // Treat an empty field as 0
  const hour = hourInput.value === '' ? 0 : parseInt(hourInput.value, 10);
  const minute = minuteInput.value === '' ? 0 : parseInt(minuteInput.value, 10);
  const second = secondInput.value === '' ? 0 : parseInt(secondInput.value, 10);

  if (isNaN(hour) || hour < 0 || hour > 23) {
    alert('Enter a valid hour (0–23)');
    return;
  }

  if (isNaN(minute) || minute < 0 || minute > 59) {
    alert('Enter valid minutes (0–59)');
    return;
  }

  if (isNaN(second) || second < 0 || second > 59) {
    alert('Enter valid seconds (0–59)');
    return;
  }

  const alarm = alarms.find(a => a.id === alarmId);
  if (!alarm) return;

  // Check whether another alarm already exists at this time
  if (hasAlarmAtTime(hour, minute, second, alarmId)) {
    alert('An alarm is already set for this time!');
    return;
  }

  // Preserve the current recurring setting while editing
  const updatedAlarm: Alarm = {
    ...alarm,
    hour,
    minute,
    second,
    scheduledAt: alarm.scheduledDate
      ? alarmTime.zonedDateTimeToTimestamp(getEffectiveTimezoneForQuick(), {
          year: Number(alarm.scheduledDate.slice(0, 4)), month: Number(alarm.scheduledDate.slice(5, 7)), day: Number(alarm.scheduledDate.slice(8, 10)),
          hour, minute, second,
        })
      : pendingEditScheduledAt,
    // Keep the recurring value unchanged
  };

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.updateAlarm(updatedAlarm);
  }

  editingAlarmId = null;
  pendingEditScheduledAt = undefined;
}

function deleteAlarm(alarmId: string): void {
  if (!confirm('Are you sure you want to delete this alarm?')) {
    return;
  }

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.deleteAlarm(alarmId);
  }
}

function toggleAlarm(alarmId: string, enabled: boolean): void {
  const alarm = alarms.find(a => a.id === alarmId);
  if (!alarm) return;

  const updatedAlarm: Alarm = {
    ...alarm,
    enabled,
  };

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.updateAlarm(updatedAlarm);
  }
}

function toggleRecurring(alarmId: string, recurring: boolean): void {
  const alarm = alarms.find(a => a.id === alarmId);
  if (!alarm) return;

  const updatedAlarm: Alarm = {
    ...alarm,
    recurring,
  };

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.updateAlarm(updatedAlarm);
  }
}

function playAlarmSound(): void {
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

      oscillator.frequency.value = 800; // Frequency in Hz
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);
    }

    // Play the sound every 0.6 seconds
    isAlarmPlaying = true;
    playBeep();
    audioInterval = setInterval(() => {
      // Check that playback is active and the notification exists
      if (audioContext && isAlarmPlaying) {
        // Check that the notification is still active
        if (alarmNotification) {
          playBeep();
        } else {
          // The notification was closed, so stop the sound
          stopAlarmSound();
        }
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
  if (notificationCheckInterval) {
    clearInterval(notificationCheckInterval);
    notificationCheckInterval = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {
      // Ignore errors during close
    });
    audioContext = null;
  }
  if (alarmNotification) {
    alarmNotification.close();
    alarmNotification = null;
  }
  updateDismissButton();
}

function updateDismissButton(): void {
  const dismissBtn = document.getElementById('dismissAlarmBtn') as HTMLButtonElement;
  if (dismissBtn) {
    dismissBtn.style.display = (isAlarmPlaying || alarmNotification !== null) ? 'block' : 'none';
  }
}

function dismissAlarm(): void {
  stopAlarmSound();
  
  // Stop blinking the tray icon
  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.dismissAlarm();
  }
}

function showAlarmNotification(alarm: Alarm): void {
  // Request notification permission
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }

  if (Notification.permission === 'granted') {
    const timeStr = formatTime(alarm.hour, alarm.minute, alarm.second);
    alarmNotification = new Notification('⏰ Alarm!', {
      body: alarm.message?.trim() || `Time: ${timeStr}`,
      requireInteraction: true,
      tag: 'alarm-alert'
    });

    // Handle notification dismissal
    const handleNotificationClose = () => {
      console.log('Browser notification closed; stopping the sound');
      // Ensure the sound stops
      if (isAlarmPlaying) {
        dismissAlarm();
      }
    };

    // Handle notification clicks
    const handleNotificationClick = () => {
      console.log('Browser notification clicked; stopping the sound');
      if (isAlarmPlaying) {
        dismissAlarm();
      }
      if (window.focus) window.focus();
    };

    // Stop the sound and blinking when the notification closes
    // Use both addEventListener and event properties for compatibility
    try {
      alarmNotification.addEventListener('close', handleNotificationClose);
    } catch (e) {
      console.warn('Could not add a close event listener:', e);
    }
    
    // Also set onclose for Electron versions that support it
    alarmNotification.onclose = handleNotificationClose;

    // Stop the sound and blinking when the notification is clicked
    try {
      alarmNotification.addEventListener('click', handleNotificationClick);
    } catch (e) {
      console.warn('Could not add a click event listener:', e);
    }
    
    alarmNotification.onclick = handleNotificationClick;
    
    // As a fallback, handle errors when the notification cannot be shown
    try {
      alarmNotification.addEventListener('error', (e) => {
        console.error('Browser notification error:', e);
      });
    } catch (e) {
      // Ignore errors while adding the error handler
    }
  } else {
    // Show an alert if notifications are unavailable
    const timeStr = formatTime(alarm.hour, alarm.minute, alarm.second);
    alert(alarm.message?.trim() || `⏰ Alarm! Time: ${timeStr}`);
    // Stop the sound and blinking after the alert closes
    dismissAlarm();
  }
}

// Expose functions for inline event handlers
(window as any).addAlarm = addAlarm;
(window as any).editAlarm = editAlarm;
(window as any).cancelEdit = cancelEdit;
(window as any).saveAlarm = saveAlarm;
(window as any).openAlarmOptions = openAlarmOptions;
(window as any).deleteAlarm = deleteAlarm;
(window as any).toggleAlarm = toggleAlarm;
(window as any).toggleRecurring = toggleRecurring;
(window as any).setQuickTime = setQuickTime;
(window as any).setQuickTimeSeconds = setQuickTimeSeconds;
(window as any).setQuickTimeForEdit = setQuickTimeForEdit;
(window as any).setQuickTimeSecondsForEdit = setQuickTimeSecondsForEdit;

// Initialize when the page loads
document.addEventListener('DOMContentLoaded', () => {
  // Request notification permission on page load
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  const optionsOverlay = document.getElementById('alarmOptionsOverlay');
  document.getElementById('newAlarmOptionsBtn')?.addEventListener('click', () => openAlarmOptions());
  document.getElementById('alarmOptionsSaveBtn')?.addEventListener('click', saveAlarmOptions);
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
      if (editingAlarmId) {
        updateTimeUntilForAlarms();
      } else {
        renderAlarms();
      }
    }, 1000);

    // Listen for triggered alarms
    electronAPI.onAlarmTriggered((alarmId) => {
      const alarm = alarms.find(a => a.id === alarmId);
      if (alarm) {
        // Play the alarm sound
        playAlarmSound();
        updateDismissButton();
        // Show a notification
        showAlarmNotification(alarm);
      }
    });

    // Listen for the main process closing a native notification
    electronAPI.onAlarmDismissFromMain(() => {
      console.log('Received a message from the main process to close the native notification');
      // Stop the sound
      isAlarmPlaying = false;
      if (audioInterval) {
        clearInterval(audioInterval);
        audioInterval = null;
      }
      if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
      }
      // Close the browser notification if it is still active
      if (alarmNotification) {
        try {
          alarmNotification.close();
        } catch (e) {
          console.error('Could not close browser notification:', e);
        }
        alarmNotification = null;
      }
      // Update the button
      updateDismissButton();
      // Acknowledge the main process (dismissAlarm has already done this)
      // The main process already stopped blinking, so only update the UI
    });
  }

  // Handle Enter in the input fields
  const hourInput = document.getElementById('newHour') as HTMLInputElement;
  const minuteInput = document.getElementById('newMinute') as HTMLInputElement;
  const secondInput = document.getElementById('newSecond') as HTMLInputElement;
  const addBtn = document.getElementById('addAlarmBtn');

  if (hourInput) {
    setupTimeInputHandlers(hourInput);
    hourInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        minuteInput?.focus();
      }
    });
  }

  if (minuteInput) {
    setupTimeInputHandlers(minuteInput);
    minuteInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        secondInput?.focus();
      }
    });
  }

  if (secondInput) {
    setupTimeInputHandlers(secondInput);
    secondInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && addBtn) {
        addAlarm();
      }
    });
  }

  if (addBtn) {
    addBtn.addEventListener('click', addAlarm);
  }

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

