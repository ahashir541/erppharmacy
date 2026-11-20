import { describe, expect, it } from 'vitest';
import { billText, DEFAULTS, fill, reorderText, signature, summaryText, waPhone, waUrl } from './wa.ts';

describe('WhatsApp', () => {
  it('reads Pakistani mobile numbers in any common form', () => {
    expect(waPhone('0300-1234567')).toBe('923001234567');
    expect(waPhone('+92 300 1234567')).toBe('923001234567');
    expect(waPhone('0092 300 1234567')).toBe('923001234567');
    expect(waPhone('3001234567')).toBe('923001234567');
    expect(waPhone('12')).toBeNull();
    expect(waPhone(null)).toBeNull();
  });

  it('writes the udhaar reminder with name, amount and days', () => {
    const text = fill(DEFAULTS.udhaar.roman, { name: 'Bilal', amount: 'Rs 2,500', days: 32, since: '1 Nov 2026', pharmacy: 'Al Shifa', sign: signature('Al Shifa', '03316368566') });
    expect(text).toContain('Bilal');
    expect(text).toContain('Rs 2,500');
    expect(text).toContain('32 din');
    expect(text).toContain('Al Shifa · 03316368566');
    expect(text).not.toMatch(/\{\w+\}/);
  });

  it('opens WhatsApp with the message encoded', () => {
    expect(waUrl('923001234567', 'Rs 100 & shukriya', 'link')).toBe('https://wa.me/923001234567?text=Rs%20100%20%26%20shukriya');
    expect(waUrl('923001234567', 'x', 'web')).toContain('web.whatsapp.com/send?phone=923001234567');
  });

  it('lists low stock for the supplier', () => {
    const t = reorderText('en', 'Al Shifa', '2026-11-20', [{ name: 'Panadol 500mg', stock: 0, unit: 'tab' }], 'Al Shifa');
    expect(t).toContain('1. Panadol 500mg');
    expect(t).toContain('in stock: 0 tab');
  });

  it('sends the bill without cost or profit, with udhaar called out', () => {
    const t = billText({ pharmacy: 'Al Shifa', branch: { name: 'Saddar', phone: '021-1234567' }, invoiceNumber: 'KHI1-C1-000045', soldAt: '20-11-2026 14:05',
      customer: 'Bilal', lines: [{ name: 'Panadol', strength: '500mg', unit: 'strip', qty: 2, unitPrice: 4000, discount: 0, lineTotal: 8000 }],
      discountTotal: 0, rounding: 0, grandTotal: 8000, payments: [], change: 0, udhaar: 8000 });
    expect(t).toContain('KHI1-C1-000045');
    expect(t).toContain('Panadol 500mg × 2 strip — Rs 80');
    expect(t).toContain('Total: Rs 80');
    expect(t).toContain('Udhaar (khaata): Rs 80');
    expect(t).not.toMatch(/cost|profit/i);
  });

  it('writes the owner summary in Urdu', () => {
    const t = summaryText('ur', 'Al Shifa', '2026-11-20', { sales: 1250000, bills: 84, low: 3, remindersDue: 5, refillsDue: 2 });
    expect(t).toContain('روزانہ حساب');
    expect(t).toContain('Rs 12,500 (84 بل)');
  });
});
