import { spawn } from 'node:child_process';
import path from 'node:path';

export async function startDisplay(scratch) {
  const display = spawn(process.env.XVFB_BINARY || path.join(scratch, 'browsers/usr/bin/Xvfb'),
    ['-displayfd', '3', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, LD_LIBRARY_PATH: [path.join(scratch, 'browsers/usr/lib64'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
    });
  let errors = '';
  display.stderr.on('data', chunk => { errors += chunk; });
  try {
    const number = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Xvfb timeout: ${errors}`)), 10000);
      display.once('error', error => { clearTimeout(timeout); reject(error); });
      display.once('exit', code => { clearTimeout(timeout); reject(new Error(`Xvfb exited ${code}: ${errors}`)); });
      display.stdio[3].once('data', data => { clearTimeout(timeout); resolve(String(data).trim()); });
    });
    return { env: { ...process.env, DISPLAY: `:${number}` }, stop: () => display.kill() };
  } catch (error) { display.kill(); throw error; }
}
