const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
for (const file of ['index.html', 'countdown.html', 'alarm-dialog.html', 'settings.html', 'time.js']) {
  fs.copyFileSync(path.join(root, 'src', file), path.join(dist, file));
}
