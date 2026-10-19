import { describe, expect, it } from 'vitest';
import { sliceUpToMessage } from './conversations';

// A forkConversation tobbi resze sqlite-ot ir, azt itt nem tudjuk futtatni:
// a better-sqlite3 az Electron ABI-jara van forditva, vitest alol nem toltheto
// be. Ami viszont valodi logika -- meddig tart a masolt elozmeny --, az tiszta
// fuggveny, es itt van tesztelve.

const messages = [
  { id: 'm1' },
  { id: 'm2' },
  { id: 'm3' },
  { id: 'm4' }
];

describe('sliceUpToMessage', () => {
  it('uzenet-id nelkul a teljes elozmenyt viszi', () => {
    expect(sliceUpToMessage(messages)).toEqual(messages);
  });

  it('a megadott uzenetet MEG beleveszi', () => {
    // "innen agazz el" azt jelenti, hogy ezt a valaszt meg latni akarom
    expect(sliceUpToMessage(messages, 'm2')).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  it('az elso uzenetre szukitve egyetlen elemet ad', () => {
    expect(sliceUpToMessage(messages, 'm1')).toEqual([{ id: 'm1' }]);
  });

  it('az utolso uzenetre szukitve a teljes listat adja', () => {
    expect(sliceUpToMessage(messages, 'm4')).toEqual(messages);
  });

  it('ismeretlen uzenet-id eseten null, nem csendben teljes masolat', () => {
    expect(sliceUpToMessage(messages, 'nincs-ilyen')).toBeNull();
  });

  it('ures elozmenyt ures listakent ad vissza', () => {
    expect(sliceUpToMessage([])).toEqual([]);
  });

  it('nem modositja az eredeti listat', () => {
    const original = [...messages];
    sliceUpToMessage(messages, 'm2');
    expect(messages).toEqual(original);
  });
});
