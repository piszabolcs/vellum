import { app, Menu, nativeImage, Tray } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AppSettings } from './shared';
import { hideWindow, markQuitting, showWindow } from './window';
import { tr } from './i18n';

let tray: Tray | null = null;

// Csomagolt appban a vite a public/ tartalmát a dist/-be másolja, ami az
// asar-ba kerül (__dirname a dist-electron az asaron belül). Fejlesztésben
// a forrás public/ mappából olvassuk.
function loadTrayIcon(): Electron.NativeImage {
  const candidates = [
    path.join(__dirname, '..', 'dist', 'vellum_logo.ico'),
    path.join(app.getAppPath(), 'public', 'vellum_logo.ico')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  }
  throw new Error('vellum_logo.ico not found in dist/ or public/');
}

interface TrayCallbacks {
  getSettings: () => AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
}

export function createTray(callbacks: TrayCallbacks): Tray {
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('Vellum');
  rebuildMenu(callbacks);
  tray.on('click', () => showWindow());
  return tray;
}

export function rebuildMenu(callbacks: TrayCallbacks): void {
  if (!tray) return;
  const settings = callbacks.getSettings();
  const menu = Menu.buildFromTemplate([
    { label: tr('tray.open'), click: () => showWindow() },
    { label: tr('tray.hide'), click: () => hideWindow() },
    { type: 'separator' },
    {
      label: tr('tray.desktop'),
      type: 'checkbox',
      checked: settings.layout === 'desktop',
      click: (item) =>
        callbacks.updateSettings({ layout: item.checked ? 'desktop' : 'bubble' })
    },
    {
      label: tr('tray.alwaysOnTop'),
      type: 'checkbox',
      checked: settings.alwaysOnTop,
      click: (item) => callbacks.updateSettings({ alwaysOnTop: item.checked })
    },
    {
      label: tr('tray.autostart'),
      type: 'checkbox',
      checked: settings.startWithWindows,
      click: (item) => callbacks.updateSettings({ startWithWindows: item.checked })
    },
    { type: 'separator' },
    {
      label: tr('tray.quit'),
      click: () => {
        markQuitting();
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}
