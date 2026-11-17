import type { ReceiptData } from '@medflow/core';
import { useEffect, useRef, useState } from 'react';
import type { AppProps, Session } from '../App.tsx';
import type { HeldBill, Receipt, Staff } from '../backend/types.ts';
import { APPROVAL_KIND } from '../cart.ts';
import { errorText, rs } from '../util.ts';
import { PinPad } from './PinPad.tsx';
import { printReceipt, ReceiptView } from './ReceiptView.tsx';

const PERMISSION_WORDS: Record<string, string> = {
  'sales.discount': 'discount above your limit', 'sales.edit_price': 'changing the price', 'sales.sell_below_min': 'selling below the minimum price',
  'sales.negative_stock': 'selling more than the shelf shows', 'udhaar.give': 'udhaar above your limit', 'sales.void': 'voiding a bill',
  'sales.return': 'a return',
};

/**
 * The owner (or a manager allowed to approve) says yes: by PIN on this counter, or from their phone.
 * Resolves with the approval's id, which the bill then carries.
 */
export function ApprovalDialog(props: AppProps & { session: Session; permission: string; amount: number | null; summary: string;
  onApproved: (approvalId: string) => void; onCancel: () => void }) {
  const { t, ctx, backend, session } = props;
  const approvers = ctx.staff.filter((s) => s.can_approve && s.id !== session.staff.id);
  const [mode, setMode] = useState<'choose' | 'pin' | 'phone'>('choose');
  const [approver, setApprover] = useState<Staff | null>(approvers[0] ?? null);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const what = PERMISSION_WORDS[props.permission] ?? props.permission;

  const request = async () => {
    if (requestId) return requestId;
    const id = await backend.requestApproval({ kind: APPROVAL_KIND[props.permission] ?? 'other', permission_code: props.permission,
      amount: props.amount, details: { summary: props.summary } }, session.sessionId);
    setRequestId(id);
    return id;
  };

  useEffect(() => {
    if (mode !== 'phone' || !requestId) return;
    const timer = window.setInterval(async () => {
      const status = await backend.approvalStatus(requestId).catch(() => 'pending');
      if (status === 'approved') { window.clearInterval(timer); props.onApproved(requestId); }
      if (status === 'rejected' || status === 'expired') { window.clearInterval(timer); setError(t('pos.approval_rejected')); }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [mode, requestId]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="card narrow">
        <h2>{t('pos.approval_title')}</h2>
        <p>{t('pos.approval_for', { what })}{props.amount !== null && props.permission === 'udhaar.give' ? ` · ${rs(props.amount)}` : ''}</p>
        {mode === 'choose' && (
          <div className="stack">
            <button type="button" className="btn primary" disabled={!approvers.length} onClick={() => setMode('pin')}>{t('pos.approval_pin')}</button>
            <button type="button" className="btn" onClick={async () => {
              try { await request(); setMode('phone'); } catch (err) { setError(errorText(err)); }
            }}>{t('pos.approval_phone')}</button>
          </div>
        )}
        {mode === 'pin' && approver && (
          <>
            <label className="field"><span>{t('pos.approver')}</span>
              <select value={approver.id} onChange={(e) => setApprover(approvers.find((a) => a.id === e.target.value)!)}>
                {approvers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <PinPad staff={approver} title={approver.name} wrongText={t('pos.wrong_pin')} submitText="OK" onOk={async () => {
              try {
                const id = await request();
                await backend.approveAtCounter(id, approver.id, session.sessionId);
                props.onApproved(id);
              } catch (err) { setError(errorText(err)); }
            }} />
          </>
        )}
        {mode === 'phone' && !error && <div className="waiting"><div className="spinner small" /> {t('pos.approval_waiting')}</div>}
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onCancel}>{t('pos.cancel')}</button></div>
      </div>
    </div>
  );
}

export interface PrescriptionInfo { id: string; patient_name: string; doctor_name: string; pharmacist_id: string | null }

/** Patient and doctor for Rx medicines; a controlled medicine also needs the pharmacist's PIN. */
export function PrescriptionDialog(props: AppProps & { needsPharmacist: boolean; onDone: (rx: PrescriptionInfo) => void; onCancel: () => void }) {
  const { t, ctx } = props;
  const pharmacists = ctx.staff.filter((s) => s.roles.some((r) => /pharmacist|owner/i.test(r)) || s.kind === 'owner');
  const [patient, setPatient] = useState('');
  const [doctor, setDoctor] = useState('');
  const [pharmacist, setPharmacist] = useState<Staff | null>(pharmacists[0] ?? null);
  const [step, setStep] = useState<'form' | 'pin'>('form');
  const done = (pid: string | null) => props.onDone({ id: crypto.randomUUID(), patient_name: patient.trim(), doctor_name: doctor.trim(), pharmacist_id: pid });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="card narrow" onSubmit={(e) => {
        e.preventDefault();
        if (!patient.trim() || !doctor.trim()) return;
        if (props.needsPharmacist) setStep('pin'); else done(null);
      }}>
        <h2>{t('pos.prescription_title')}</h2>
        <p className="muted">{t('pos.prescription_hint')}</p>
        {step === 'form' ? (
          <>
            <label className="field"><span>{t('pos.patient')}</span><input autoFocus value={patient} onChange={(e) => setPatient(e.target.value)} required /></label>
            <label className="field"><span>{t('pos.doctor')}</span><input value={doctor} onChange={(e) => setDoctor(e.target.value)} required /></label>
            <div className="row-actions">
              <button type="button" className="btn ghost" onClick={props.onCancel}>{t('pos.cancel')}</button>
              <button type="submit" className="btn primary">{t('pos.continue')}</button>
            </div>
          </>
        ) : pharmacist && (
          <>
            <label className="field"><span>{t('pos.pharmacist')}</span>
              <select value={pharmacist.id} onChange={(e) => setPharmacist(pharmacists.find((p) => p.id === e.target.value)!)}>
                {pharmacists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <PinPad staff={pharmacist} title={pharmacist.name} wrongText={t('pos.wrong_pin')} submitText="OK" onOk={() => done(pharmacist.id)} />
            <div className="row-actions"><button type="button" className="btn ghost" onClick={() => setStep('form')}>{t('common.back')}</button></div>
          </>
        )}
      </form>
    </div>
  );
}

export function HeldDialog(props: AppProps & { bills: HeldBill[]; onResume: (b: HeldBill) => void; onClose: () => void }) {
  const { t } = props;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onKeyDown={(e) => { if (e.key === 'Escape') props.onClose(); }}>
      <div className="card">
        <h2>{t('pos.held_bills')}</h2>
        {props.bills.length === 0 ? <p className="muted">{t('pos.no_held')}</p> : (
          <ul className="held-list">
            {props.bills.map((b, i) => (
              <li key={b.id}>
                <div><strong>{b.label}</strong><div className="muted small">{new Date(b.held_at).toLocaleTimeString()} · {b.by}</div></div>
                <button type="button" className="btn primary" autoFocus={i === 0} onClick={() => props.onResume(b)}>{t('pos.resume')}</button>
              </li>
            ))}
          </ul>
        )}
        <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onClose}>{t('pos.cancel')}</button></div>
      </div>
    </div>
  );
}

export function receiptData(r: Receipt, cashier: string, customer: string | null, footer: string | null): ReceiptData {
  return {
    pharmacy: r.pharmacy,
    branch: { name: r.branch.name, address: r.branch.address, phone: r.branch.phone },
    invoiceNumber: r.invoice_number,
    soldAt: new Date(r.sold_at).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ''),
    cashier, customer,
    lines: r.lines.map((l) => ({ name: l.name, strength: l.strength && l.name.toLowerCase().includes(l.strength.toLowerCase()) ? null : l.strength, unit: l.unit, qty: l.qty, unitPrice: l.unit_price, discount: l.discount,
                                 lineTotal: l.line_total, batch: l.batch, expiry: l.expiry })),
    discountTotal: r.discount_total, rounding: r.rounding, grandTotal: r.grand_total,
    payments: r.payments ?? [], change: r.change, udhaar: r.udhaar, footer,
  };
}

export function ReceiptDialog(props: AppProps & { receipt: ReceiptData; onClose: () => void }) {
  const { t, ctx } = props;
  const width: 58 | 80 = ctx.settings.receipt_width === 58 ? 58 : 80;
  const ref = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const print = () => printReceipt(paper.current?.firstElementChild as HTMLElement | null, width);
  // Enter prints and Esc starts the next sale, wherever the focus is.
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); print(); }
      if (e.key === 'Escape' || e.key === 'F2') { e.preventDefault(); e.stopPropagation(); props.onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="card receipt-card" ref={ref} tabIndex={-1}>
        <div className="done-head">
          <span className="done-tick">✓</span>
          <div>
            <h2>{t('pos.sale_done')}</h2>
            <div className="muted">{t('pos.invoice', { no: props.receipt.invoiceNumber })}</div>
          </div>
          <div className="done-total">{rs(props.receipt.grandTotal)}</div>
        </div>
        {props.receipt.change > 0 && <div className="change-banner">{t('sale.change')}: {rs(props.receipt.change)}</div>}
        <div className="receipt-stage" ref={paper}><ReceiptView r={props.receipt} width={width} /></div>
        <div className="row-actions">
          <button type="button" className="btn" onClick={print}>{t('pos.print')}</button>
          <button type="button" className="btn primary" onClick={props.onClose}>{t('pos.new_sale')}</button>
        </div>
      </div>
    </div>
  );
}
