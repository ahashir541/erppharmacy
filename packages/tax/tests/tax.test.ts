import { describe, expect, it } from 'vitest';
import { FbrPosProvider, localDateTime } from '../src/fbr.ts';
import { MockTaxProvider } from '../src/mock.ts';
import { send, type TaxDocument } from '../src/types.ts';
import { runTaxWorker, type Claimed } from '../src/worker.ts';

const doc = (over: Partial<TaxDocument> = {}): TaxDocument => ({
  submission_id: 's1', provider: 'fbr', environment: 'sandbox', sequence: 1, document_type: 'sale',
  invoice_number: 'KHI1-C1-000451', original_invoice_number: null, original_authority_number: null,
  issued_at: '2026-11-16T07:30:00Z',
  seller: { ntn: '1234567', strn: null, pos_id: '123456', registration_no: null, name: 'Demo Pharmacy', branch: 'Saddar' },
  buyer: { name: null, phone: null, cnic: null }, payment_mode: 'cash',
  items: [
    { code: '8964000123', name: 'Panadol 500mg', quantity: 2, unit: 'strip', item_code: '3004.9099', tax_rate_bp: 0,
      sale_value: 6000, tax: 0, discount: 0, total: 6000 },
    { code: '8964000999', name: 'Sunblock SPF 50', quantity: 1, unit: 'tube', item_code: '3304.9900', tax_rate_bp: 1800,
      sale_value: 84746, tax: 15254, discount: 0, total: 100000 },
  ],
  totals: { quantity: 3, sale_value: 90746, tax: 15254, discount: 0, total: 106000 },
  ...over,
});

describe('FBR POS adapter', () => {
  const fbr = new FbrPosProvider();

  it('maps the invoice to FBR fields, in rupees, with the token', () => {
    const req = fbr.toRequest(doc(), { token: 'tok' });
    const body = JSON.parse(req.body);
    expect(req.url).toContain('esp.fbr.gov.pk');
    expect(req.headers.Authorization).toBe('Bearer tok');
    expect(body).toMatchObject({ POSID: 123456, USIN: 'KHI1-C1-000451', DateTime: '2026-11-16 12:30:00', TotalBillAmount: 1060,
      TotalSaleValue: 907.46, TotalTaxCharged: 152.54, TotalQuantity: 3, PaymentMode: 1, InvoiceType: 1 });
    expect(body.Items[1]).toMatchObject({ PCTCode: '3304.9900', TaxRate: 18, SaleValue: 847.46, TaxCharged: 152.54, TotalAmount: 1000 });
  });

  it('sends a return as a refund against the original invoice, with negative amounts', () => {
    const body = JSON.parse(fbr.toRequest(doc({ document_type: 'return', invoice_number: 'KHI1-C1-R000003',
      original_invoice_number: 'KHI1-C1-000451', original_authority_number: '123456FBR789' }), { token: 't' }).body);
    expect(body.InvoiceType).toBe(3);
    expect(body.RefUSIN).toBe('123456FBR789');
    expect(body.TotalBillAmount).toBe(-1060);
  });

  it('refuses to build a request without a token or POS ID (not retried)', async () => {
    const r = await send(fbr, doc(), {}, async () => { throw new Error('not called'); });
    expect(r).toMatchObject({ accepted: false, retryable: false });
  });

  it('reads answers: accepted, refused, busy, unreachable', async () => {
    expect(fbr.fromResponse(200, '{"InvoiceNumber":"123456FBR789","Code":"100","Response":"Invoice received successfully"}'))
      .toMatchObject({ accepted: true, authorityNumber: '123456FBR789' });
    expect(fbr.fromResponse(200, '{"Code":"401","Response":"Invalid PCT code"}')).toMatchObject({ accepted: false, retryable: false, error: 'Invalid PCT code' });
    expect(fbr.fromResponse(503, 'down')).toMatchObject({ accepted: false, retryable: true });
    const r = await send(fbr, doc(), { token: 't' }, async () => { throw new Error('ECONNRESET'); });
    expect(r).toMatchObject({ accepted: false, retryable: true });
  });

  it('uses Pakistan time', () => {
    expect(localDateTime('2026-11-16T20:15:00Z')).toBe('2026-11-17 01:15:00');
  });
});

describe('tax worker', () => {
  it('sends what it claims and records every answer', async () => {
    const mock = new MockTaxProvider('fbr', 3);
    const queue: Claimed[] = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, tenant_id: 't', provider: 'fbr', attempt: 1, vault_secret_id: null,
      document: doc({ sequence: n, invoice_number: `KHI1-C1-00000${n}` }) }));
    const recorded: Array<[string, boolean]> = [];
    let claimed = false;
    const stats = await runTaxWorker({
      providers: { fbr: mock }, fetch: async () => { throw new Error('no network in tests'); },
      queue: {
        claim: async () => (claimed ? [] : ((claimed = true), queue)),
        record: async (id, r) => { recorded.push([id, r.accepted]); },
        credentials: async () => ({}),
      },
    });
    expect(stats).toEqual({ sent: 4, accepted: 3, failed: 1 });
    expect(recorded).toHaveLength(4);
  });
});
