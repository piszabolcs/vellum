// ============================================================================
// vellum - i18n.ts (main process)
// ============================================================================
// User-facing texts produced by the main process: tray menu, dialogs, notices,
// error bubbles. The renderer has its own dictionary (src/i18n); the language
// follows settings.language and is switched by setMainLanguage().
// English is the reference; Hungarian falls back to it key by key.
// ============================================================================

import type { Language } from './shared';

const en = {
  // tray
  'tray.open': 'Open',
  'tray.hide': 'Hide',
  'tray.desktop': 'Desktop view',
  'tray.alwaysOnTop': 'Always on top',
  'tray.autostart': 'Start with Windows',
  'tray.quit': 'Quit',

  // dialogs
  'dialog.pickRoot': 'Choose the folder Vellum may read',
  'dialog.cancel': 'Cancel',
  'dialog.useAnyway': 'Use this folder',
  'dialog.broadRootTitle': 'This folder is very broad',
  'dialog.broadRootDetail':
    '"{path}" is a drive root or contains your user profile. The model could read every text file below it. Pick a narrower folder unless you really mean it.',

  // notices
  'notice.memoryCorrupt':
    'memory.json could not be read, so Vellum started with an empty memory. The original file was kept as {path}.',
  'notice.memoryLocked':
    'memory.json could not be read or moved aside. Memory changes are not saved until the file is fixed.',
  'notice.settingsCorrupt':
    'settings.json could not be read, so the default settings are used. The original file was kept as {path}.',
  'notice.dbWriteFailed':
    'A message could not be saved to the conversation archive: {reason}',
  'notice.legacyFallback':
    'Your old memory could not be split into entries (the model was not reachable), so it was added as one suggestion. Review it under Settings > Memory.',
  'notice.legacyMigrated':
    '{count} suggestions were created from your old memory. Approve them under Settings > Memory.',

  // chat errors (shown in the error bubble)
  'chat.modelMissing': 'The model "{model}" is not installed. Run: ollama pull {model}',
  'chat.httpError': 'Ollama returned HTTP {status}.{detail}',
  'chat.noStream': 'Ollama did not return a streamable response.',
  'chat.empty': 'Ollama returned an empty reply.',
  'chat.idleTimeout':
    'The model sent nothing for too long (idle timeout). A large model can take a while to load - try again, or pick a smaller model in Settings.',
  'chat.unreachable':
    'Could not reach Ollama at {host}. Make sure Ollama is running (ollama serve), then press Retry.',
  'chat.noAnswer': 'Could not generate an answer.',
  'chat.thinkingBudget': '\n[thinking budget reached, continuing in fast mode]\n',

  // connection test (Settings > Model)
  'health.httpError': 'Ollama returned HTTP {status}.',
  'health.modelMissing': 'Ollama is reachable, but the model "{model}" is not installed. Run: ollama pull {model}',
  'health.ok': 'Reachable, the model "{model}" is installed.',
  'health.unreachable': 'Not reachable: {reason}',

  // skills (shown in Settings > Skills)
  'skills.noFrontmatter': 'missing YAML frontmatter (the file must start with a "---" line)',
  'skills.unclosed': 'the frontmatter is not closed by a second "---" line',
  'skills.invalidYaml': 'invalid YAML frontmatter: {reason}',
  'skills.notMap': 'the frontmatter must be a list of "key: value" pairs',
  'skills.missingName': 'the required "name" field is missing',
  'skills.missingDescription': 'the required "description" field is missing',
  'skills.nameMismatch': 'the "name" field ("{name}") does not match the folder name ("{folder}")',
  'skills.badName': 'the name may only contain lowercase letters, digits and hyphens, and cannot start or end with a hyphen',
  'skills.descriptionTooLong': 'the "description" field is too long (max 1024 characters)',
  'skills.nameRule': 'the name may only contain lowercase letters, digits and hyphens (e.g. my-glossary)',
  'skills.exists': 'a skill with this name already exists',
  'skills.createFailed': 'could not create the skill',

  // conversations (export / fork)
  'conv.forkSuffix': ' (branch)',
  'conv.untitled': 'Untitled conversation',
  'conv.created': 'Created: {date}',
  'conv.model': 'Model: {model}',
  'conv.me': 'Me',
  'conv.sources': 'Sources:',

  // migration from Haverom
  'migration.done': 'Your previous Haverom settings were carried over.',
  'migration.memory':
    'Your old memory is here too - you will see it as suggestions under Settings > Memory, they are added after approval.',
  'migration.note': 'Note: {warnings}.',
  'migration.untouched': 'The Haverom folder was left untouched, you can go back to it at any time.',

  // diagnostics additions from the main process
  'diag.hotkeyTitle': 'The global hotkey ({accelerator}) is not active',
  'diag.hotkeyDetail': '{reason}. Pick another combination in Settings, or close the other program.',
  'diag.hotkeyRaw': 'Global hotkey: {accelerator} - NOT active ({reason})',
  'diag.unknownReason': 'unknown reason',

  // misc
  'db.unavailable': 'no database',
  'hotkey.inUse': 'another program already uses this combination',
  'hotkey.invalid': 'invalid hotkey: it needs Ctrl, Alt or Win plus one key',
} as const;

export type MainStringKey = keyof typeof en;

const hu: Partial<Record<MainStringKey, string>> = {
  'tray.open': 'Megnyitás',
  'tray.hide': 'Elrejtés',
  'tray.desktop': 'Asztali nézet',
  'tray.alwaysOnTop': 'Mindig felül',
  'tray.autostart': 'Indítás a Windowszal',
  'tray.quit': 'Kilépés',

  'dialog.pickRoot': 'Válaszd ki a mappát, amit a Vellum olvashat',
  'dialog.cancel': 'Mégse',
  'dialog.useAnyway': 'Ezt a mappát használom',
  'dialog.broadRootTitle': 'Ez a mappa nagyon tág',
  'dialog.broadRootDetail':
    '„{path}” egy meghajtó gyökere, vagy a felhasználói profilodat tartalmazza. A modell minden alatta lévő szövegfájlt olvashatna. Válassz szűkebb mappát, hacsak nem pontosan ezt szeretnéd.',

  'notice.memoryCorrupt':
    'A memory.json nem olvasható, ezért a Vellum üres memóriával indult. Az eredeti fájl megmaradt: {path}.',
  'notice.memoryLocked':
    'A memory.json nem olvasható és nem is helyezhető át. A memória változásai nem mentődnek, amíg a fájl rendbe nem jön.',
  'notice.settingsCorrupt':
    'A settings.json nem olvasható, ezért az alapbeállítások élnek. Az eredeti fájl megmaradt: {path}.',
  'notice.dbWriteFailed': 'Egy üzenetet nem sikerült menteni a beszélgetés-archívumba: {reason}',
  'notice.legacyFallback':
    'A régi memóriádat nem sikerült szétbontani (a modell nem volt elérhető), ezért egyben került be javaslatként. A Beállítások > Memória fülön nézheted át.',
  'notice.legacyMigrated':
    'A régi memóriádból {count} javaslat készült. A Beállítások > Memória fülön hagyhatod jóvá őket.',

  'chat.modelMissing': 'A(z) "{model}" modell nincs lehúzva. Futtasd: ollama pull {model}',
  'chat.httpError': 'Az Ollama HTTP {status} hibát adott vissza.{detail}',
  'chat.noStream': 'Az Ollama nem adott vissza streamelhető választ.',
  'chat.empty': 'Az Ollama üres választ adott vissza.',
  'chat.idleTimeout':
    'A modell túl sokáig nem küldött semmit (időtúllépés). Nagy modellnél a hidegindítás lassú lehet – próbáld újra, vagy válassz kisebb modellt a Beállításokban.',
  'chat.unreachable':
    'Nem érem el az Ollamát itt: {host}. Ellenőrizd, hogy fut-e (ollama serve), majd nyomd meg az Újra gombot.',
  'chat.noAnswer': 'Nem sikerült választ generálni.',
  'chat.thinkingBudget': '\n[a gondolkodás elérte a keretet, gyors módban folytatom]\n',

  'health.httpError': 'Az Ollama HTTP {status} hibát adott vissza.',
  'health.modelMissing': 'Az Ollama elérhető, de a(z) "{model}" modell nincs lehúzva. Futtasd: ollama pull {model}',
  'health.ok': 'Elérhető, a(z) "{model}" modell le van húzva.',
  'health.unreachable': 'Nem elérhető: {reason}',

  'skills.noFrontmatter': 'hiányzik a YAML frontmatter (a fájlnak "---" sorral kell kezdődnie)',
  'skills.unclosed': 'a frontmatter nincs lezárva egy második "---" sorral',
  'skills.invalidYaml': 'hibás YAML frontmatter: {reason}',
  'skills.notMap': 'a frontmatternek "kulcs: érték" párokból kell állnia',
  'skills.missingName': 'hiányzik a kötelező "name" mező',
  'skills.missingDescription': 'hiányzik a kötelező "description" mező',
  'skills.nameMismatch': 'a "name" mező ("{name}") nem egyezik a mappa nevével ("{folder}")',
  'skills.badName': 'a név csak kisbetűt, számot és kötőjelet tartalmazhat, és nem kezdődhet vagy végződhet kötőjellel',
  'skills.descriptionTooLong': 'a "description" mező túl hosszú (max 1024 karakter)',
  'skills.nameRule': 'a név csak kisbetűt, számot és kötőjelet tartalmazhat (például: my-glossary)',
  'skills.exists': 'már létezik ilyen nevű skill',
  'skills.createFailed': 'nem sikerült létrehozni a skillt',
  'conv.forkSuffix': ' (elágazás)',
  'conv.untitled': 'Névtelen beszélgetés',
  'conv.created': 'Létrehozva: {date}',
  'conv.model': 'Modell: {model}',
  'conv.me': 'Én',
  'conv.sources': 'Források:',
  'migration.done': 'A korábbi Haverom beállításaid átkerültek.',
  'migration.memory':
    'A régi memóriád is megvan — a Beállítások > Memória fülön javaslatokként fogod látni, jóváhagyás után kerülnek be.',
  'migration.note': 'Megjegyzés: {warnings}.',
  'migration.untouched': 'A Haverom mappa érintetlen maradt, bármikor visszatérhetsz rá.',
  'diag.hotkeyTitle': 'A gyorsbillentyű ({accelerator}) nem él',
  'diag.hotkeyDetail': '{reason}. Válassz másik kombinációt a Beállításokban, vagy zárd be a másik programot.',
  'diag.hotkeyRaw': 'Gyorsbillentyű: {accelerator} — NEM aktív ({reason})',
  'diag.unknownReason': 'ismeretlen ok',
  'db.unavailable': 'nincs adatbázis',
  'hotkey.inUse': 'egy másik program már használja ezt a kombinációt',
  'hotkey.invalid': 'érvénytelen gyorsbillentyű: Ctrl, Alt vagy Win + egy billentyű kell',
};

let language: Language = 'en';

export function setMainLanguage(next: Language): void {
  language = next;
}

export function getMainLanguage(): Language {
  return language;
}

export function tr(key: MainStringKey, vars?: Record<string, string | number>): string {
  let text: string = (language === 'hu' ? hu[key] : undefined) ?? en[key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
