/** Egy válasz mérési időbélyegei (Date.now() ms-ban). */
export interface TimingMarks {
  start: number;
  firstThinking?: number;
  firstContent?: number;
  end: number;
}

export interface MessageTimings {
  totalMs: number;
  /** Csak akkor van, ha volt gondolkodás ÉS utána valódi válasz-tartalom is érkezett. */
  thinkingMs?: number;
}

/**
 * A gondolkodási idő az első gondolkodás-darab és az első válasz-tartalom
 * darab közti idő — nem a teljes streamelés vége, mert a válasz streamelése
 * maga is másodpercekig tarthat, azt a totalMs már lefedi.
 */
export function computeTimings(marks: TimingMarks): MessageTimings {
  const totalMs = marks.end - marks.start;
  if (marks.firstThinking !== undefined && marks.firstContent !== undefined) {
    return { totalMs, thinkingMs: marks.firstContent - marks.firstThinking };
  }
  return { totalMs };
}
