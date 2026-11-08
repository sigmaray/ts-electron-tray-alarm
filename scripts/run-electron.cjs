const { spawn } = require('node:child_process');

const multiInstance = process.argv.includes('--multi-instance');
const args = process.argv.slice(2).filter((arg) => arg !== '--multi-instance');
const env = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' };
if (multiInstance) env.ALLOW_ONLY_ONE_INSTANCE = 'false';

const child = spawn(require('electron'), ['--no-sandbox', '.', ...args], {
  stdio: 'inherit',
  env,
});
child.on('error', (error) => {
  console.error('Could not start Electron:', error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
