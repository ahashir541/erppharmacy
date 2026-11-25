// A customer brings medicine back: find the bill, choose what comes back and why, refund in cash or
// to their khata. Damaged packs are not put back on the shelf. A salesman may need the owner's OK.
import { useEffect, useRef, useState } from 'react';
import type { AppProps, Session } from '../App.tsx';
import { PosError } from '../backend/types.ts';
import { errorText, rs, uuid } from '../util.ts';
import { ApprovalDialog } from './Dialogs.tsx';

interface Bill {
  sale_id: string; invoice_number: string; sold_at: string; grand_total: number; customer: string | null; on_khata: boolean;
  lines: Array<{ sale_line_id: string; name: string; unit: string; factor: number; qty: number; qty_base: number; unit_price: number; line_total: number;
                 batch: string; returned_base: number }>;
}

export function ReturnDialog(props: AppProps & { session: Session; seq: number; onDone: (text: string) => void; onClose: () => void }) {
  const { backend, session, ctx } = props;
  const [invoice, setInvoice] = useState('');
  const [bill, setBill] = useState<Bill | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [damaged, setDamaged] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState('Not needed');
  const [method, setMethod] = useState<'cash' | 'udhaar_credit'>('cash');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{ amount: number } | null>(null);
  const [returnId] = useState(uuid());
  const billInput = useRef<HTMLInputElement>(null);
  // Take the cursor from the POS search box (which keeps grabbing it) into the bill number box.
  useEffect(() => { const t = window.setTimeout(() => billInput.current?.focus(), 50); return () => window.clearTimeout(t); }, []);

  const find = async () => {
    setError(null);
    try {
      const b = await backend.billForReturn(invoice.trim());
      setBill(b as Bill);
      setMethod((b as Bill).on_khata ? 'udhaar_credit' : 'cash');
      setQty({});
    } catch (err) { setError(errorText(err)); }
  };

  const chosen = (bill?.lines ?? []).map((l) => ({ l, n: Math.max(0, Math.min(Number(qty[l.sale_line_id] || 0), Math.floor((l.qty_base - l.returned_base) / l.factor))) })).filter((x) => x.n > 0);
  const refund = chosen.reduce((s, { l, n }) => s + Math.round((l.line_total * n * l.factor) / l.qty_base), 0);

  const submit = async (approvalId: string | null = null) => {
    if (!bill || !chosen.length) return;
    setBusy(true); setError(null);
    try {
      const r = await backend.postReturn({
        id: returnId, local_seq: props.seq, original_sale_id: bill.sale_id, refund_method: method, reason, approval: approvalId,
        drawer_session_id: ctx.open_shift?.drawer_session_id ?? null, returned_at: new Date().toISOString(),
        lines: chosen.map(({ l, n }) => ({ sale_line_id: l.sale_line_id, qty_base: n * l.factor, restock: !damaged[l.sale_line_id],
                                           condition: damaged[l.sale_line_id] ? 'damaged' : 'sealed' })),
      }, session.sessionId);
      props.onDone(`Return ${r.return_number}: ${method === 'cash' ? 'give back' : 'credited to khata'} ${rs(r.refund_total)}`);
    } catch (err) {
      if (err instanceof PosError && err.needsApproval) setApproval({ amount: refund });
      else setError(errorText(err));
    } finally { setBusy(false); }
  };

  if (approval) {
    return <ApprovalDialog {...props} permission="sales.return" amount={approval.amount} summary={`Return on ${bill?.invoice_number} · ${rs(approval.amount)}`}
                           onCancel={() => setApproval(null)} onApproved={(id) => { setApproval(null); void submit(id); }} />;
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onKeyDown={(e) => { if (e.key === 'Escape') props.onClose(); }}>
      <div className="card wide-card">
        <h2>Return</h2>
        <form className="row-inline" onSubmit={(e) => { e.preventDefault(); void find(); }}>
          <input ref={billInput} placeholder="Bill number, or just its last digits (e.g. 12)" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
          <button className="btn">Find bill</button>
        </form>
        {bill && (
          <>
            <div className="muted small">{bill.invoice_number} · {new Date(bill.sold_at).toLocaleString('en-GB')} · {rs(bill.grand_total)}{bill.customer ? ` · ${bill.customer}` : ''}</div>
            <div className="return-lines">
              {bill.lines.map((l) => {
                const left = Math.floor((l.qty_base - l.returned_base) / l.factor);
                return (
                  <div key={l.sale_line_id} className={`return-line${left === 0 ? ' done' : ''}`}>
                    <div><strong>{l.name}</strong><div className="muted small">{l.qty} {l.unit} · {rs(l.unit_price)} each · batch {l.batch}{l.returned_base ? ` · ${l.returned_base / l.factor} already returned` : ''}</div></div>
                    <input inputMode="numeric" aria-label={`Quantity of ${l.name} to return`} disabled={left === 0} placeholder={`0–${left}`}
                           value={qty[l.sale_line_id] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [l.sale_line_id]: e.target.value.replace(/\D/g, '') }))} />
                    <label className="check small"><input type="checkbox" checked={!!damaged[l.sale_line_id]} onChange={(e) => setDamaged((d) => ({ ...d, [l.sale_line_id]: e.target.checked }))} /> Damaged</label>
                  </div>
                );
              })}
            </div>
            <div className="form-grid">
              <label className="field"><span>Why</span>
                <select value={reason} onChange={(e) => setReason(e.target.value)}>
                  {['Not needed', 'Wrong medicine', 'Doctor changed prescription', 'Damaged pack', 'Near expiry', 'Other'].map((r) => <option key={r}>{r}</option>)}
                </select>
              </label>
              <label className="field"><span>Refund</span>
                <select value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'udhaar_credit')}>
                  <option value="cash">Cash from the drawer</option>
                  {bill.on_khata && <option value="udhaar_credit">Reduce the customer's khata</option>}
                </select>
              </label>
            </div>
            <div className="refund-total">Refund <strong>{rs(refund)}</strong></div>
          </>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions">
          <button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !chosen.length} onClick={() => void submit()}>{busy ? '…' : 'Take return'}</button>
        </div>
      </div>
    </div>
  );
}
