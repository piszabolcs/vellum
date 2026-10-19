export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('hu-HU', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

let idCounter = 0;
export function generateId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** Ezredmásodpercet másodperc-stringgé alakít egy tizedesjeggyel, pl. 4200 -> "4.2". */
export function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
