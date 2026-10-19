// ============================================================================
// vellum - hotkey.ts (F11)
// ============================================================================
// globalis gyorsbillentyu az ablak elohivasahoz.
//
// A tálcaikon es a bubórék csak akkor erheto el, ha epp latszik valami a
// kepernyobol. Egy globalis billentyu az egyetlen ut, ami teljes kepernyos
// alkalmazas alol is mukodik.
//
// FONTOS: a regisztracio ELBUKHAT, ha mas program mar lefoglalta ugyanazt a
// kombinaciot. Ezt NEM nyeljuk le nemán -- a felhasznalo kulonben azt hinne,
// hogy az app romlott el, pedig csak utkozes van.
// ============================================================================

import { globalShortcut } from 'electron';
import { isValidAccelerator } from './shared';
import { tr } from './i18n';

export interface HotkeyStatus {
  /** ures string = a gyorsbillentyu ki van kapcsolva */
  accelerator: string;
  registered: boolean;
  /** miert nem sikerult, ha nem sikerult */
  error: string | null;
}

let status: HotkeyStatus = { accelerator: '', registered: false, error: null };

export function getHotkeyStatus(): HotkeyStatus {
  return status;
}

/**
 * Beallitja (vagy kikapcsolja) a gyorsbillentyut.
 *
 * Minden hivas eloszor leszedi a korabbit, hogy beallitas-valtaskor ne
 * maradjon ott a regi kombinacio is.
 */
export function applyHotkey(accelerator: string, onTrigger: () => void): HotkeyStatus {
  globalShortcut.unregisterAll();

  const trimmed = accelerator.trim();

  if (trimmed.length === 0) {
    status = { accelerator: '', registered: false, error: null };
    return status;
  }

  // Never grab a bare key (or Shift+key) system-wide, even if settings.json
  // was edited by hand.
  if (!isValidAccelerator(trimmed)) {
    status = { accelerator: trimmed, registered: false, error: tr('hotkey.invalid') };
    return status;
  }

  try {
    const ok = globalShortcut.register(trimmed, onTrigger);

    status = {
      accelerator: trimmed,
      registered: ok,
      error: ok ? null : tr('hotkey.inUse'),
    };
  } catch (error) {
    // ervenytelen gyorsbillentyu-szoveg (pl. elgepelt modositó) kivetelt dob
    status = {
      accelerator: trimmed,
      registered: false,
      error: error instanceof Error ? `${tr('hotkey.invalid')} (${error.message})` : tr('hotkey.invalid'),
    };
  }

  return status;
}

export function releaseHotkey(): void {
  globalShortcut.unregisterAll();
  status = { accelerator: status.accelerator, registered: false, error: null };
}
