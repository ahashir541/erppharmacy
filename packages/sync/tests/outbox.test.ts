import { describe, expect, it } from 'vitest';
import { Outbox } from '../src/outbox.ts';
import { syncStatus } from '../src/status.ts';

const counter = () => {
  let t = Date.UTC(2026, 10, 9, 9, 0, 0);
  return new Outbox({
    devicePrefix: 'KHI1-C2', nextCommandSeq: 1, nextInvoiceSeq: 451, nextReturnSeq: 1, staffId: null, sessionId: null,
    drawerSessionId: null, settings: { pricesIncludeTax: true, roundingStep: 100 },
  }, () => new Date((t += 60_000)));
};

describe('outbox', () => {
  it('numbers commands and bills on the PC, in order', () => {
    const o = counter();
    o.signIn('salman');
    o.openDrawer('drawer-1', 500_000);
    const s = o.sale({ lines: [{ productUnitId: 'pu', batchId: 'b', qty: 2, unitPrice: 4_550 }], payments: [{ method: 'cash', tendered: 10_000 }] });
    expect(s.invoiceNumber).toBe('KHI1-C2-000451');
    expect(s.bill.grandTotal).toBe(9_100);
    expect(s.settlement.change).toBe(900);
    expect(o.pending.map((c) => [c.device_seq, c.kind])).toEqual([[1, 'staff_session_start'], [2, 'drawer_open'], [3, 'sale']]);
    expect(o.pending.every((c) => c.acting_user === 'salman')).toBe(true);
    expect(s.command.payload).toMatchObject({ local_seq: 451, grand_total: 9_100 });
  });

  it('needs a signed-in person and a customer for udhaar', () => {
    const o = counter();
    expect(() => o.sale({ lines: [], payments: [] })).toThrow(/sign in/);
    o.signIn('salman');
    expect(() => o.sale({ lines: [{ productUnitId: 'pu', batchId: 'b', qty: 1, unitPrice: 300_000 }], payments: [{ method: 'cash', tendered: 100_000 }] }))
      .toThrow(/customer/);
  });

  it('a blind close sends only what was counted', () => {
    const o = counter();
    o.signIn('salman');
    o.openDrawer('drawer-1', 500_000);
    const c = o.closeDrawer(512_300);
    expect(Object.keys(c.payload).sort()).toEqual(['counted', 'denominations', 'drawer_session_id']);
  });

  it('drops commands once the server confirms them', () => {
    const o = counter();
    const a = o.signIn('salman');
    o.signOut();
    o.acknowledge([a.id]);
    expect(o.pending.map((c) => c.kind)).toEqual(['staff_session_end']);
  });
});

describe('sync status', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  it('says Synced, Syncing, Offline with a count, or Needs attention', () => {
    expect(syncStatus({ online: true, uploading: false, pending: 0, rejected: 0, lastSyncAt: now, now }).label).toBe('Synced');
    expect(syncStatus({ online: true, uploading: true, pending: 3, rejected: 0, lastSyncAt: now, now }).label).toBe('Syncing 3…');
    expect(syncStatus({ online: false, uploading: false, pending: 12, rejected: 0, lastSyncAt: new Date('2026-11-09T09:00:00Z'), now }).label).toBe('Offline · 12 waiting');
    expect(syncStatus({ online: true, uploading: false, pending: 0, rejected: 1, lastSyncAt: now, now }).state).toBe('needs_attention');
    expect(syncStatus({ online: false, uploading: false, pending: 0, rejected: 0, lastSyncAt: new Date('2026-11-05T00:00:00Z'), now }).state).toBe('needs_attention');
  });
});
