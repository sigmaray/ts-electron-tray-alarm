// Типы для electronAPI
interface Alarm {
  id: string;
  hour: number;
  minute: number;
  second: number;
  enabled: boolean;
}

interface ElectronAPI {
  minimizeWindow: () => void;
  closeApp: () => void;
  addAlarm: (alarm: Alarm) => void;
  updateAlarm: (alarm: Alarm) => void;
  deleteAlarm: (alarmId: string) => void;
  getAllAlarms: () => void;
  onAlarmsUpdated: (callback: (alarms: Alarm[]) => void) => void;
  onAlarmTriggered: (callback: (alarmId: string) => void) => void;
  removeAlarmsUpdatedListener: () => void;
  removeAlarmTriggeredListener: () => void;
}

let alarms: Alarm[] = [];
let editingAlarmId: string | null = null;

function generateAlarmId(): string {
  return `alarm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function formatTime(hour: number, minute: number, second: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function renderAlarms(): void {
  const container = document.getElementById('alarmsList');
  if (!container) return;

  if (alarms.length === 0) {
    container.innerHTML = '<div class="no-alarms">Нет установленных будильников</div>';
    return;
  }

  // Сортируем будильники по времени
  const sortedAlarms = [...alarms].sort((a, b) => {
    if (a.hour !== b.hour) return a.hour - b.hour;
    if (a.minute !== b.minute) return a.minute - b.minute;
    return a.second - b.second;
  });

  container.innerHTML = sortedAlarms.map(alarm => {
    const isEditing = editingAlarmId === alarm.id;
    const timeStr = formatTime(alarm.hour, alarm.minute, alarm.second);
    
    if (isEditing) {
      return `
        <div class="alarm-item editing" data-id="${alarm.id}">
          <div class="alarm-time-input">
            <input type="number" min="0" max="23" value="${alarm.hour}" class="hour-input" id="edit-hour-${alarm.id}">
            <span>:</span>
            <input type="number" min="0" max="59" value="${alarm.minute}" class="minute-input" id="edit-minute-${alarm.id}">
            <span>:</span>
            <input type="number" min="0" max="59" value="${alarm.second}" class="second-input" id="edit-second-${alarm.id}">
          </div>
          <div class="alarm-actions">
            <button class="btn-save" onclick="saveAlarm('${alarm.id}')">Сохранить</button>
            <button class="btn-cancel" onclick="cancelEdit('${alarm.id}')">Отмена</button>
          </div>
        </div>
      `;
    } else {
      return `
        <div class="alarm-item" data-id="${alarm.id}">
          <div class="alarm-info">
            <span class="alarm-time">${timeStr}</span>
            <label class="alarm-toggle">
              <input type="checkbox" ${alarm.enabled ? 'checked' : ''} onchange="toggleAlarm('${alarm.id}', this.checked)">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="alarm-actions">
            <button class="btn-edit" onclick="editAlarm('${alarm.id}')">Редактировать</button>
            <button class="btn-delete" onclick="deleteAlarm('${alarm.id}')">Удалить</button>
          </div>
        </div>
      `;
    }
  }).join('');
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
    alert('Введите корректный час (0-23)');
    return;
  }

  if (isNaN(minute) || minute < 0 || minute > 59) {
    alert('Введите корректные минуты (0-59)');
    return;
  }

  if (isNaN(second) || second < 0 || second > 59) {
    alert('Введите корректные секунды (0-59)');
    return;
  }

  const newAlarm: Alarm = {
    id: generateAlarmId(),
    hour,
    minute,
    second,
    enabled: true,
  };

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.addAlarm(newAlarm);
  }

  // Сбрасываем поля ввода
  hourInput.value = '00';
  minuteInput.value = '00';
  secondInput.value = '00';
}

function editAlarm(alarmId: string): void {
  editingAlarmId = alarmId;
  renderAlarms();
}

function cancelEdit(alarmId: string): void {
  editingAlarmId = null;
  renderAlarms();
}

function saveAlarm(alarmId: string): void {
  const hourInput = document.getElementById(`edit-hour-${alarmId}`) as HTMLInputElement;
  const minuteInput = document.getElementById(`edit-minute-${alarmId}`) as HTMLInputElement;
  const secondInput = document.getElementById(`edit-second-${alarmId}`) as HTMLInputElement;

  if (!hourInput || !minuteInput || !secondInput) return;

  const hour = parseInt(hourInput.value, 10);
  const minute = parseInt(minuteInput.value, 10);
  const second = parseInt(secondInput.value, 10);

  if (isNaN(hour) || hour < 0 || hour > 23) {
    alert('Введите корректный час (0-23)');
    return;
  }

  if (isNaN(minute) || minute < 0 || minute > 59) {
    alert('Введите корректные минуты (0-59)');
    return;
  }

  if (isNaN(second) || second < 0 || second > 59) {
    alert('Введите корректные секунды (0-59)');
    return;
  }

  const alarm = alarms.find(a => a.id === alarmId);
  if (!alarm) return;

  const updatedAlarm: Alarm = {
    ...alarm,
    hour,
    minute,
    second,
  };

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.updateAlarm(updatedAlarm);
  }

  editingAlarmId = null;
}

function deleteAlarm(alarmId: string): void {
  if (!confirm('Вы уверены, что хотите удалить этот будильник?')) {
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

// Экспортируем функции для глобального доступа
(window as any).addAlarm = addAlarm;
(window as any).editAlarm = editAlarm;
(window as any).cancelEdit = cancelEdit;
(window as any).saveAlarm = saveAlarm;
(window as any).deleteAlarm = deleteAlarm;
(window as any).toggleAlarm = toggleAlarm;

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    // Запрашиваем список будильников
    electronAPI.getAllAlarms();

    // Слушаем обновления будильников
    electronAPI.onAlarmsUpdated((updatedAlarms) => {
      alarms = updatedAlarms;
      renderAlarms();
    });

    // Слушаем срабатывание будильника
    electronAPI.onAlarmTriggered((alarmId) => {
      const alarm = alarms.find(a => a.id === alarmId);
      if (alarm) {
        alert(`⏰ Будильник! Время: ${formatTime(alarm.hour, alarm.minute, alarm.second)}`);
      }
    });
  }

  // Обработка Enter в полях ввода
  const hourInput = document.getElementById('newHour') as HTMLInputElement;
  const minuteInput = document.getElementById('newMinute') as HTMLInputElement;
  const secondInput = document.getElementById('newSecond') as HTMLInputElement;
  const addBtn = document.getElementById('addAlarmBtn');

  if (hourInput) {
    hourInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        minuteInput?.focus();
      }
    });
  }

  if (minuteInput) {
    minuteInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        secondInput?.focus();
      }
    });
  }

  if (secondInput) {
    secondInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && addBtn) {
        addAlarm();
      }
    });
  }

  if (addBtn) {
    addBtn.addEventListener('click', addAlarm);
  }

  // Обработчики кнопок управления приложением
  const minimizeBtn = document.getElementById('minimizeBtn');
  const closeBtn = document.getElementById('closeBtn');

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
      const confirmed = confirm('Вы уверены, что хотите закрыть приложение?');
      if (confirmed) {
        const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
        if (electronAPI) {
          electronAPI.closeApp();
        }
      }
    });
  }
});

