import { BrowserWindow, screen, shell } from 'electron';
import * as path from 'path';
import { BubbleCorner, Layout } from './shared';

// Egyetlen frameless, átlátszó ablak, ami két állapot között vált:
//   - collapsed: kis lebegő buborék a választott alsó sarokban
//   - expanded:  chat panel: kompakt doboz / fél képernyő / teljes, és a
//                széleinél szabadon átméretezhető

const MARGIN = 16;
// Az összecsukott ablak szándékosan nagyobb a 68px buboréknál, hogy a lágy
// árnyék körben kifusson benne (különben az átlátszó ablak széle négyzetesre vágja).
const COLLAPSED = { width: 140, height: 140 };
const EXPANDED = { width: 452, height: 652 }; // 420x620 panel + 16px árnyék margó körben
// Lower bound for manual resizing (CSS px at zoom 1): below this the header
// buttons would collide. With "large text" the zoom factor scales it up.
const MIN_EXPANDED = { width: 400, height: 440 };
const LARGE_TEXT_ZOOM = 1.18;
// Az asztali nézet is a buborékéhoz hasonló margós trükköt használ: a látható
// panel (DESKTOP_PANEL) körül MARGIN px transzparens hely marad az ablakban,
// hogy a kerekített sarkú panel lágy árnyéka ki tudjon futni, ne vágódjon
// szögletesre az átlátszó ablak szélén.
const DESKTOP_PANEL = { width: 1100, height: 720 };
const DESKTOP = { width: DESKTOP_PANEL.width + MARGIN * 2, height: DESKTOP_PANEL.height + MARGIN * 2 };
const MIN_DESKTOP_PANEL = { width: 760, height: 480 };
const MIN_DESKTOP = {
  width: MIN_DESKTOP_PANEL.width + MARGIN * 2,
  height: MIN_DESKTOP_PANEL.height + MARGIN * 2
};

let mainWindow: BrowserWindow | null = null;
let expanded = false;
// A Windows a setBounds/show/setResizable után hajlamos elejteni az always-on-top
// jelzőt, ezért eltároljuk, és minden ilyen művelet után újra ráhúzzuk.
let alwaysOnTop = true;
let corner: BubbleCorner = 'bottom-right';
let layout: Layout = 'bubble';
let largeText = false;

function cornerBounds(size: { width: number; height: number }) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const y = workArea.y + workArea.height - size.height - MARGIN;
  const x =
    corner === 'bottom-left'
      ? workArea.x + MARGIN
      : workArea.x + workArea.width - size.width - MARGIN;
  return { x, y, width: size.width, height: size.height };
}

/** Az asztali nézet nagy, középre igazított ablaka — a munkaterületnél nem nagyobb. */
function desktopBounds() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(DESKTOP.width, workArea.width - MARGIN * 2);
  const height = Math.min(DESKTOP.height, workArea.height - MARGIN * 2);
  const x = workArea.x + Math.floor((workArea.width - width) / 2);
  const y = workArea.y + Math.floor((workArea.height - height) / 2);
  return { x, y, width, height };
}

function zoomFactor(): number {
  return largeText ? LARGE_TEXT_ZOOM : 1;
}

/** Window size for CSS-pixel content at the current zoom, never larger than the work area. */
function zoomed(size: { width: number; height: number }) {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    width: Math.min(Math.round(size.width * zoomFactor()), workArea.width - MARGIN * 2),
    height: Math.min(Math.round(size.height * zoomFactor()), workArea.height - MARGIN * 2)
  };
}

function minimumSize() {
  const base = layout === 'desktop' ? MIN_DESKTOP : MIN_EXPANDED;
  return zoomed(base);
}

/** A nyitott panel helye a nézet szerint: buborék módban sarok-kompakt, asztali módban nagy középre. */
function expandedBounds() {
  if (layout === 'desktop') return desktopBounds();
  // The compact panel grows with "large text", so it never starts below its own minimum
  // (Windows would otherwise enlarge it from the top-left and push it out of the corner).
  const min = minimumSize();
  const size = zoomed(EXPANDED);
  return cornerBounds({ width: Math.max(size.width, min.width), height: Math.max(size.height, min.height) });
}

/** Keeps a rectangle inside the primary work area (used when a minimum enlarges the window). */
function insideWorkArea(bounds: Electron.Rectangle): Electron.Rectangle {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height);
  return { x, y, width, height };
}

/**
 * A buborék fix méretű: a minimum méretet vissza kell venni, mielőtt
 * összecsukunk, különben az expanded minimum (380px) felfújná a 140px buborékot.
 */
function applySizeConstraints(): void {
  if (!mainWindow) return;
  if (expanded) {
    // The minimum is defined in CSS pixels; with the large-text zoom the same
    // layout needs proportionally more window pixels.
    const min = minimumSize();
    // order matters: on Windows setResizable() resets the minimum size
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(min.width, min.height);
    const bounds = mainWindow.getBounds();
    if (!mainWindow.isMaximized() && (bounds.width < min.width || bounds.height < min.height)) {
      // grow, but stay on the work area (never past the screen edge)
      mainWindow.setBounds(
        insideWorkArea({
          ...bounds,
          width: Math.max(bounds.width, min.width),
          height: Math.max(bounds.height, min.height)
        })
      );
    }
  } else {
    mainWindow.setResizable(false);
    mainWindow.setMinimumSize(COLLAPSED.width, COLLAPSED.height);
  }
}

function applyZoom(): void {
  mainWindow?.webContents.setZoomFactor(largeText ? LARGE_TEXT_ZOOM : 1);
}

function reapplyAlwaysOnTop(): void {
  if (!mainWindow || !alwaysOnTop || layout === 'desktop') return;
  // A false-ra állítás nélkül a Windows néha figyelmen kívül hagyja az ismételt true-t.
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
}

export function createMainWindow(
  initialAlwaysOnTop: boolean,
  initialCorner: BubbleCorner,
  initialLargeText: boolean,
  initialLayout: Layout
): BrowserWindow {
  corner = initialCorner;
  largeText = initialLargeText;
  layout = initialLayout;
  alwaysOnTop = initialAlwaysOnTop;
  // Asztali nézetben nincs "buborék" állapot: induláskor rögtön a nagy nézet
  // jelenik meg, nem a sarokban lebegő pötty.
  expanded = layout === 'desktop';
  mainWindow = new BrowserWindow({
    ...(expanded ? expandedBounds() : cornerBounds(COLLAPSED)),
    icon: path.join(__dirname, '..', 'dist', 'vellum_logo.ico'),
    frame: false,
    transparent: true,
    resizable: expanded,
    maximizable: layout === 'desktop',
    fullscreenable: false,
    skipTaskbar: layout !== 'desktop',
    alwaysOnTop: layout === 'desktop' ? false : alwaysOnTop,
    hasShadow: false, // nincs négyzetes OS-ablakárnyék az átlátszó ablak körül
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  applySizeConstraints();

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    reapplyAlwaysOnTop();
  });
  // A zoom faktort a tartalom betöltése után lehet érvényesíteni.
  mainWindow.webContents.on('did-finish-load', () => applyZoom());

  // A modell válaszában lévő linkek a rendszer böngészőjében nyíljanak,
  // ne az app ablakában (ne lehessen "elnavigálni" az appból).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  // Bezárás: alapból tray-be megy, nem lép ki.
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  return mainWindow;
}

let quitting = false;
export function markQuitting(): void {
  quitting = true;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Straight to the final place and size in ONE step, then the minimum. Growing the current
 * window first (from its top-left corner) would push it past the screen edge, possibly onto
 * another monitor with a different scale, and Windows would then size the panel wrongly.
 */
function placeExpanded(): void {
  if (!mainWindow) return;
  const target = expandedBounds();
  mainWindow.setResizable(true);
  mainWindow.setBounds(target);
  applySizeConstraints();
  mainWindow.setBounds(target);
}

export function setExpanded(value: boolean): void {
  if (!mainWindow) return;
  expanded = value;
  if (expanded) {
    placeExpanded();
  } else {
    applySizeConstraints();
    mainWindow.setBounds(cornerBounds(COLLAPSED));
  }
  // Buborékká csukás után a legfontosabb: e nélkül a buborék más ablakok mögé csúszik.
  reapplyAlwaysOnTop();
}

/**
 * A nézetváltás mindig az adott nézet "megnyitott" állapotát mutatja — sem a
 * buborékba, sem tálcára nem esik vissza magától, mert épp aktívan
 * interaktál a felhasználó (fejléc-gomb vagy tálcamenü).
 */
export function setLayout(value: Layout): void {
  layout = value;
  expanded = true;
  // Windowson a setBounds no-op, amíg az ablak maximalizált, ezért előbb
  // visszaállítjuk – különben buborékra váltva teljes méretben ragadna, ráadásul
  // a skipTaskbar miatt a tálcáról is eltűnve, gyakorlatilag visszahozhatatlanul.
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  mainWindow?.setSkipTaskbar(layout !== 'desktop');
  mainWindow?.setMaximizable(layout === 'desktop');
  if (layout === 'desktop') mainWindow?.setAlwaysOnTop(false);
  placeExpanded();
  mainWindow?.show();
  reapplyAlwaysOnTop();
}

/** Az asztali fejléc kicsinyítés-gombjához: valódi OS-minimalizálás a tálcára. */
export function minimizeWindow(): void {
  mainWindow?.minimize();
}

/** Az asztali fejléc teljes méret-gombjához: OS-szintű maximalizálás váltása. */
export function toggleMaximizeWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
}

export function isExpanded(): boolean {
  return expanded;
}

export function showWindow(): void {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  reapplyAlwaysOnTop();
}

export function hideWindow(): void {
  mainWindow?.hide();
}

export function setAlwaysOnTop(value: boolean): void {
  alwaysOnTop = value;
  if (value) reapplyAlwaysOnTop();
  else mainWindow?.setAlwaysOnTop(false);
}

export function setCorner(value: BubbleCorner): void {
  corner = value;
  // Az aktuális állapot (buborék/panel) megtartásával áthelyezzük a sarokba.
  mainWindow?.setBounds(expanded ? expandedBounds() : cornerBounds(COLLAPSED));
  reapplyAlwaysOnTop();
}

export function setLargeText(value: boolean): void {
  largeText = value;
  applyZoom();
  applySizeConstraints();
  // an open compact panel follows the new text size, keeping its corner
  if (mainWindow && expanded && layout !== 'desktop' && !mainWindow.isMaximized()) {
    mainWindow.setBounds(expandedBounds());
  }
}
