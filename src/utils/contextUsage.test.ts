import { describe, expect, it } from 'vitest';
import { contextUsage, estimateTokens, levelFromRatio, measuredUsed } from './contextUsage';
import type { ChatMessage } from '../types/chat';

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: '',
    timestamp: Date.now(),
    ...partial
  };
}

describe('estimateTokens', () => {
  it('magyar szoveget surubben szamol, mint az angolt', () => {
    // A surubb szamolas per KARAKTER ervenyes, ezert a ket mintanak pontosan
    // egyforma hosszunak kell lennie -- kulonben a hosszkulonbseg elnyomja a
    // surusegkulonbseget, es a ceil() ugyanarra a szamra kerekit.
    const huText = 'árvíztűrő tükörfúrógép';
    const enText = 'the quick brown fox aa';
    expect(huText.length).toBe(enText.length);
    expect(estimateTokens(huText)).toBeGreaterThan(estimateTokens(enText));
  });

  it('a kodblokkot surubben szamolja', () => {
    const prose = estimateTokens('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const code = estimateTokens('```\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n```');
    expect(code).toBeGreaterThan(prose);
  });

  it('ures bemenetre 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('levelFromRatio', () => {
  it('a hatarok: 60% figyelmeztetes, 75% kritikus', () => {
    expect(levelFromRatio(0.59)).toBe('ok');
    expect(levelFromRatio(0.61)).toBe('warn');
    expect(levelFromRatio(0.76)).toBe('critical');
  });
});

describe('contextUsage', () => {
  it('a hibabuborekokat NEM szamolja bele', () => {
    // a hibauzenetek nem mennek a modellnek (a store kiszuri oket),
    // ezert a kontextus-merestbol is ki kell maradniuk
    const hosszu = 'x'.repeat(4000);
    const withError = contextUsage(
      [msg({ role: 'assistant', content: hosszu, error: true })],
      32768
    );
    const empty = contextUsage([], 32768);
    expect(withError.used).toBe(empty.used);
  });

  it('az utolso felhasznaloi uzenetet az "aktualis" sorba teszi', () => {
    const usage = contextUsage(
      [
        msg({ id: 'a', role: 'user', content: 'régi kérdés' }),
        msg({ id: 'b', role: 'assistant', content: 'válasz' }),
        msg({ id: 'c', role: 'user', content: 'friss kérdés' })
      ],
      32768
    );
    expect(usage.breakdown.current).toBeGreaterThan(0);
    expect(usage.breakdown.history).toBeGreaterThan(0);
  });

  it('a behuzott forrasokat kulon sorban mutatja', () => {
    const usage = contextUsage(
      [
        msg({
          role: 'assistant',
          content: 'válasz',
          sources: [
            { id: 'F1', url: 'https://a.hu', title: 'A' },
            { id: 'F2', url: 'https://b.hu', title: 'B' }
          ]
        })
      ],
      32768
    );
    expect(usage.breakdown.retrieved).toBeGreaterThan(0);
  });

  it('az osszefoglalo a rendszer-sorba szamit bele', () => {
    const without = contextUsage([], 32768);
    const withSummary = contextUsage([], 32768, 'Eddigi döntések: ...');
    expect(withSummary.breakdown.system).toBeGreaterThan(without.breakdown.system);
  });
});

const stats = (promptTokens: number) => ({
  promptTokens,
  evalTokens: 10,
  tokensPerSecond: 20
});

describe('measuredUsed', () => {
  it('meres nelkul null -- ilyenkor a becslesre kell esni vissza', () => {
    expect(measuredUsed([msg({ role: 'user', content: 'Szia' })])).toBeNull();
  });

  it('a legutobbi valasz mert prompt-tokenjeit veszi alapul', () => {
    const used = measuredUsed([
      msg({ role: 'user', content: 'Szia' }),
      msg({ role: 'assistant', content: '', stats: stats(5000) })
    ]);
    // a valasz maga mar ures, tehat gyakorlatilag a mert ertek marad
    expect(used).toBeGreaterThanOrEqual(5000);
  });

  it('a meres ota irt uzeneteket hozzaadja', () => {
    const base = measuredUsed([
      msg({ role: 'user', content: 'Szia' }),
      msg({ role: 'assistant', content: '', stats: stats(5000) })
    ]);
    const withMore = measuredUsed([
      msg({ role: 'user', content: 'Szia' }),
      msg({ role: 'assistant', content: '', stats: stats(5000) }),
      msg({ role: 'user', content: 'x'.repeat(4000) })
    ]);
    expect(withMore!).toBeGreaterThan(base!);
  });

  it('a legFRISSEBB merest hasznalja, nem a legelsot', () => {
    const used = measuredUsed([
      msg({ role: 'assistant', content: '', stats: stats(1000) }),
      msg({ role: 'assistant', content: '', stats: stats(9000) })
    ]);
    expect(used).toBeGreaterThanOrEqual(9000);
  });

  it('a hibabuborekokat nem szamolja bele', () => {
    const clean = measuredUsed([
      msg({ role: 'assistant', content: '', stats: stats(5000) })
    ]);
    const withError = measuredUsed([
      msg({ role: 'assistant', content: '', stats: stats(5000) }),
      msg({ role: 'assistant', content: 'x'.repeat(4000), error: true })
    ]);
    expect(withError).toBe(clean);
  });
});
