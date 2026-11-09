import { describe, expect, it } from 'vitest';
import { formatReceipt, toEscPos, type ReceiptData } from '../src/receipt.ts';

const r: ReceiptData = {
  pharmacy: 'Demo Pharmacy', branch: { name: 'Saddar', address: 'Shop 4, Zaib-un-Nisa Street, Karachi', phone: '021-1234567' },
  invoiceNumber: 'KHI1-C2-000451', soldAt: '28-10-2026 14:05', cashier: 'Salman',
  lines: [
    { name: 'Panadol', strength: '500 mg', unit: 'strip', qty: 2, unitPrice: 4_500, discount: 0, lineTotal: 9_000, batch: 'P123', expiry: '2027-12' },
    { name: 'Augmentin', strength: '625 mg', unit: 'box', qty: 1, unitPrice: 105_000, discount: 5_000, lineTotal: 100_000 },
  ],
  discountTotal: 5_000, taxTotal: 0, rounding: 0, grandTotal: 109_000,
  payments: [{ method: 'cash', amount: 50_000 }], change: 0, udhaar: 59_000, taxPending: true,
};

describe('receipt', () => {
  it('fits every line in the paper width', () => {
    for (const paper of [58, 80] as const) {
      const lines = formatReceipt(r, paper);
      expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(paper === 58 ? 32 : 48);
    }
  });

  it('shows the total, the credit mark and the FBR status', () => {
    const text = formatReceipt(r, 80).join('\n');
    expect(text).toMatch(/TOTAL Rs\s+1,090\.00/);
    expect(text).toContain('*** CREDIT (UDHAAR) ***');
    expect(text).toMatch(/On account\s+590\.00/);
    expect(text).toContain('FBR: pending');
    expect(text).toContain('Batch P123  Exp 2027-12');
  });

  it('builds ESC/POS bytes with reset, cut and drawer kick', () => {
    const bytes = toEscPos(['Hi'], { openDrawer: true });
    expect([...bytes.slice(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...bytes.slice(2, 5)]).toEqual([0x48, 0x69, 0x0a]);
    expect([...bytes.slice(-5)]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  });
});
