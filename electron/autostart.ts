import { app } from 'electron';

// "Start with Windows" a Windows login item API-val. Csomagolt appnál stabil;
// fejlesztés közben az electron.exe-t regisztrálja az app útvonalával.

export function applyAutostart(enabled: boolean): void {
  if (process.platform !== 'win32') return;
  try {
    const target = app.isPackaged
      ? {}
      : { path: process.execPath, args: [app.getAppPath()] };
    // Only touch the login item when it differs: start-up must not write the
    // registry just to confirm the default (off).
    if (app.getLoginItemSettings(target).openAtLogin === enabled) return;
    app.setLoginItemSettings({ openAtLogin: enabled, ...target });
  } catch (err) {
    console.error('Failed to apply autostart setting:', err);
  }
}
