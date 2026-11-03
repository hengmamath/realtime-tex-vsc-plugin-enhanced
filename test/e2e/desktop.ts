import { execFileSync } from 'node:child_process';

export function desktopLocked(): boolean {
  return process.platform === 'darwin' && /"IOConsoleLocked"\s*=\s*Yes/.test(
    execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1'], { encoding: 'utf8' }),
  );
}
