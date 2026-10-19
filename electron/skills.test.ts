import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { initSkills, loadSkillCatalog, parseFrontmatter } from './skills';

describe('skill frontmatter', () => {
  it('reads every bundled skill with its complete folded description', async () => {
    initSkills(path.resolve(process.cwd(), 'skills'));
    const catalog = await loadSkillCatalog();

    expect(catalog.length).toBeGreaterThanOrEqual(3);
    for (const skill of catalog) {
      expect(skill.error, skill.name).toBeUndefined();
      expect(skill.description.startsWith('>'), skill.name).toBe(false);
      expect(skill.description, skill.name).toMatch(/(Keywords|Kulcsszavak):/);
    }
  });

  it('keeps continuation lines with colons and reads lists and metadata', () => {
    const parsed = parseFrontmatter(
      [
        '---',
        'name: demo',
        'description: >-',
        '  First line.',
        '  Keywords: a, b: c',
        'allowed-tools: [read_file, calc]',
        'metadata:',
        '  author: someone',
        '  version: "1.0"',
        '---',
        'Body',
      ].join('\n'),
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.fields.description).toBe('First line. Keywords: a, b: c');
    expect(parsed.fields['allowed-tools']).toBe('read_file calc');
    expect(parsed.nested.metadata).toEqual({ author: 'someone', version: '1.0' });
    expect(parsed.body).toBe('Body');
  });
});
