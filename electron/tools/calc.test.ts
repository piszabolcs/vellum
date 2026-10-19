import { describe, expect, it } from 'vitest';

import { evaluateExpression } from './calc';

describe('calculator', () => {
  it('evaluates arithmetic, percentages, functions and unit conversion', () => {
    expect(evaluateExpression('2+3*4').value).toBe(14);
    expect(evaluateExpression('(2+3)*4').value).toBe(20);
    expect(evaluateExpression('2^10').value).toBe(1024);
    expect(evaluateExpression('100 * 20%').value).toBe(20);
    expect(evaluateExpression('sqrt(16)').value).toBe(4);
    expect(evaluateExpression('5 km to m').formatted).toContain('5000');
  });

  it('never executes code and rejects unknown names, prototype keys and huge input', () => {
    for (const input of ['process.exit()', 'constructor', '__proto__', 'toString(1)', '1/0', 'x'.repeat(600)]) {
      expect(evaluateExpression(input).ok, input).toBe(false);
    }
  });
});
