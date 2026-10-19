import { describe, expect, it } from 'vitest';
import { isModelTag } from '../../electron/shared';
import { MODEL_CATALOG, findCatalogModel, parseParamsB } from './modelCatalog';

describe('model catalog', () => {
  it('has well-formed, unique entries', () => {
    expect(MODEL_CATALOG.length).toBeGreaterThanOrEqual(20);
    expect(new Set(MODEL_CATALOG.map((m) => m.tag)).size).toBe(MODEL_CATALOG.length);
    for (const model of MODEL_CATALOG) {
      expect(isModelTag(model.tag), model.tag).toBe(true);
      expect(model.diskGB, model.tag).toBeGreaterThan(0);
      expect(parseParamsB(model.params), model.tag).toBeGreaterThan(0);
      if (model.activeParams) expect(parseParamsB(model.activeParams), model.tag).toBeGreaterThan(0);
      expect(model.contextK, model.tag).toBeGreaterThan(0);
      expect(model.strengths.length, model.tag).toBeGreaterThan(10);
    }
  });

  it('covers the required models and marks the embedding ones', () => {
    const required = [
      'qwen3:1.7b', 'qwen3:4b', 'qwen3:8b', 'qwen3:14b', 'qwen3:30b-a3b', 'llama3.2:1b', 'llama3.2:3b',
      'llama3.1:8b', 'gemma3:1b', 'gemma3:4b', 'gemma3:12b', 'phi4-mini', 'phi4', 'mistral-small3.2',
      'deepseek-r1:8b', 'deepseek-r1:14b', 'granite3.3:2b', 'granite3.3:8b', 'bge-m3', 'nomic-embed-text'
    ];
    for (const tag of required) expect(findCatalogModel(tag), tag).toBeDefined();
    expect(findCatalogModel('bge-m3')?.kind).toBe('embedding');
    expect(findCatalogModel('nomic-embed-text')?.kind).toBe('embedding');
    expect(findCatalogModel('qwen3:30b-a3b')?.activeParams).toBe('3B');
  });

  it('parses parameter counts and matches installed names with :latest', () => {
    expect(parseParamsB('8B')).toBe(8);
    expect(parseParamsB('567M')).toBeCloseTo(0.567);
    expect(parseParamsB('lots')).toBeNaN();
    expect(findCatalogModel('bge-m3:latest')?.tag).toBe('bge-m3');
    expect(findCatalogModel('QWEN3:8B')?.tag).toBe('qwen3:8b');
    expect(findCatalogModel('qwen3:9000b')).toBeUndefined();
  });
});
