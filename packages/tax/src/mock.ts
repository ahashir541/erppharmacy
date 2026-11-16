// A pretend tax authority for tests, demos and training: accepts documents and hands out numbers,
// and can be told to be unreachable now and then.
import type { HttpRequest, TaxDocument, TaxProvider, TaxResult } from './types.ts';

export class MockTaxProvider implements TaxProvider {
  readonly id: string;
  /** Every document it received, in arrival order (including failed attempts). */
  readonly received: Array<{ invoice: string; sequence: number; accepted: boolean }> = [];
  private next = 1;
  private readonly failEvery: number;
  constructor(id = 'mock', failEvery = 0) {
    this.id = id;
    this.failEvery = failEvery;
  }

  toRequest(doc: TaxDocument): HttpRequest {
    return { url: 'mock://tax', method: 'POST', headers: {}, body: JSON.stringify(doc) };
  }

  fromResponse(): TaxResult {
    throw new Error('MockTaxProvider answers through submit()');
  }

  submit(doc: TaxDocument): TaxResult {
    const fail = this.failEvery > 0 && (this.received.length + 1) % this.failEvery === 0;
    this.received.push({ invoice: doc.invoice_number, sequence: doc.sequence, accepted: !fail });
    if (fail) return { accepted: false, retryable: true, error: 'Network unreachable', response: null };
    const n = `MOCK${String(this.next++).padStart(10, '0')}`;
    return { accepted: true, authorityNumber: n, qr: n, response: { InvoiceNumber: n, Code: '100' } };
  }
}
