import { describe, expect, it } from 'vitest';
import { POS_MESSAGES, tr } from './i18n.ts';

describe('POS words', () => {
  it('every key exists in English and Urdu with the same placeholders', () => {
    expect(Object.keys(POS_MESSAGES.ur).sort()).toEqual(Object.keys(POS_MESSAGES.en).sort());
    for (const [k, v] of Object.entries(POS_MESSAGES.en)) {
      const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(vars((POS_MESSAGES.ur as Record<string, string>)[k]!), k).toEqual(vars(v));
    }
  });
  it('falls back to the shared words', () => {
    expect(tr('sale.udhaar', 'ur')).toBe('ادھار');
    expect(tr('pos.invoice', 'en', { no: 'KHI1-C1-000001' })).toBe('Bill KHI1-C1-000001');
  });
});
