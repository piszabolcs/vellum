/**
 * Rögzített méretű minta-lista: a sparkline-oknak kell, hogy csak az utolsó
 * N mérést tartsák meg memóriában (nincs perzisztencia, nincs store — a
 * komponens saját lokális state-jében hívva).
 */
export function pushSample<T>(samples: T[], next: T, maxLen: number): T[] {
  const updated = [...samples, next];
  return updated.length > maxLen ? updated.slice(updated.length - maxLen) : updated;
}
