import type { PaymentMethod, ReceiptData } from '@medflow/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppProps, Session } from '../App.tsx';
import { PosError, type CustomerHit, type HeldBill, type Product } from '../backend/types.ts';
import { APPROVAL_KEY, emptyCart, priceCart, salePayload, settle, unitOf, type CartLine, type CartState } from '../cart.ts';
import { errorText, rs, rsShort, shortDate, toPaisa, uuid } from '../util.ts';
import { ApprovalDialog, HeldDialog, PrescriptionDialog, ReceiptDialog, receiptData, type PrescriptionInfo } from './Dialogs.tsx';
import { CloseShift } from './Shift.tsx';

const METHODS: Array<{ id: PaymentMethod; key: 'sale.cash' | 'sale.card' | 'sale.jazzcash' | 'sale.easypaisa' | 'pos.bank_transfer' }> = [
  { id: 'cash', key: 'sale.cash' }, { id: 'bank_transfer', key: 'pos.bank_transfer' }, { id: 'easypaisa', key: 'sale.easypaisa' },
  { id: 'jazzcash', key: 'sale.jazzcash' }, { id: 'card', key: 'sale.card' },
];

type Dialog =
  | { kind: 'approval'; permission: string; amount: number | null }
  | { kind: 'prescription' }
  | { kind: 'held'; bills: HeldBill[] }
  | { kind: 'receipt'; data: ReceiptData }
  | { kind: 'close_shift' }
  | null;

/** The cart as stored in a held bill (enough to rebuild it; stock and prices are read again on resume). */
interface HeldCart { lines: Array<{ product: Product; unitId: string; qty: number; discountPct: number; priceOverride: number | null }>;
                     billDiscount: number; customer: CustomerHit | null; note: string }

export function Pos(props: AppProps & { session: Session; onSignOut: () => void; onToggleLang: () => void }) {
  const { t, ctx, backend, session, lang } = props;
  const [cart, setCart] = useState<CartState>(emptyCart);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [active, setActive] = useState(0);
  const [searched, setSearched] = useState('');
  const [custQuery, setCustQuery] = useState('');
  const [custResults, setCustResults] = useState<CustomerHit[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [approvals, setApprovals] = useState<Record<string, string>>({});
  const [prescription, setPrescription] = useState<PrescriptionInfo | null>(null);
  const [nextSeq, setNextSeq] = useState(ctx.next_invoice_seq);
  const [billDiscountText, setBillDiscountText] = useState('');
  const [cashText, setCashText] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);
  const custRef = useRef<HTMLInputElement>(null);
  const billDiscRef = useRef<HTMLInputElement>(null);
  const cashRef = useRef<HTMLInputElement>(null);
  const rowInputs = useRef(new Map<string, HTMLInputElement>());
  const saleId = useRef(uuid());

  const priced = useMemo(() => priceCart(cart, ctx.settings.rounding_step), [cart, ctx.settings.rounding_step]);
  const grand = priced.bill?.grandTotal ?? 0;
  const settlement = useMemo(() => {
    try { return grand > 0 ? settle(cart, grand) : null; } catch { return null; }
  }, [cart, grand]);

  const say = (text: string, tone: 'error' | 'info' = 'error') => setMessage({ text, tone });
  // Focus moves at once (a barcode scanner types faster than a timer fires), and again after React
  // has re-drawn, in case the search box was re-rendered.
  const focusSearch = () => { searchRef.current?.focus(); window.setTimeout(() => searchRef.current?.focus(), 0); };
  useEffect(() => { focusSearch(); }, []);

  // ---- Search ----
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); setSearched(''); return; }
    const timer = window.setTimeout(async () => {
      try {
        const r = await backend.search(q);
        setResults(r);
        setActive(0);
        setSearched(q);
        // A full barcode scan adds the item at once.
        if (r.length === 1 && r[0]!.barcode_unit_id && /^\d{8,14}$/.test(q)) {
          await addProduct(r[0]!, r[0]!.barcode_unit_id);
        }
      } catch (err) { say(errorText(err)); }
    }, /^\d{8,14}$/.test(q) ? 0 : 140);
    return () => window.clearTimeout(timer);
  }, [query]);

  const addProduct = useCallback(async (p: Product, unitId?: string | null) => {
    setMessage(null);
    // Clear the search at once: the next scan may already be arriving while batches load.
    setQuery('');
    setResults([]);
    focusSearch();
    if (p.stock_base <= 0) { say(`${p.name}: ${t('pos.out_of_stock')}`); return; }
    const batches = await backend.batches(p.product_id);
    const preferred = unitId ?? p.units.find((u) => u.unit === 'strip')?.product_unit_id
      ?? [...p.units].sort((a, b) => a.factor - b.factor)[0]!.product_unit_id;
    setCart((c) => {
      const existing = c.lines.findIndex((l) => l.product.product_id === p.product_id && l.unitId === preferred);
      if (existing >= 0) {
        const lines = c.lines.map((l, i) => (i === existing ? { ...l, qty: l.qty + 1, batches } : l));
        setSelected(existing);
        return { ...c, lines };
      }
      setSelected(c.lines.length);
      const line: CartLine = { key: uuid(), product: p, unitId: preferred, qty: 1, batches, priceOverride: null, discountPct: 0 };
      return { ...c, lines: [...c.lines, line] };
    });
  }, [backend, t]);

  const updateLine = (i: number, patch: Partial<CartLine>) => setCart((c) => ({ ...c, lines: c.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const removeLine = (i: number) => {
    setCart((c) => ({ ...c, lines: c.lines.filter((_, j) => j !== i) }));
    setSelected((s) => Math.max(0, Math.min(s, cart.lines.length - 2)));
  };

  // ---- Customer ----
  useEffect(() => {
    const q = custQuery.trim();
    if (q.length < 2) { setCustResults([]); return; }
    const timer = window.setTimeout(() => { backend.customers(q).then(setCustResults).catch((err) => say(errorText(err))); }, 150);
    return () => window.clearTimeout(timer);
  }, [custQuery]);

  const resetSale = () => {
    setCart(emptyCart());
    setSelected(0);
    setApprovals({});
    setPrescription(null);
    setBillDiscountText('');
    setCashText('');
    setCustQuery('');
    setMessage(null);
    saleId.current = uuid();
    focusSearch();
  };

  // ---- Completing the sale ----
  const needsRx = cart.lines.some((l) => l.product.rx_required || l.product.is_controlled);
  const needsPharmacist = cart.lines.some((l) => l.product.is_controlled);

  const complete = async (extraApprovals: Record<string, string> = approvals, rx: PrescriptionInfo | null = prescription) => {
    if (busy || !cart.lines.length) return;
    if (priced.problems.length) { say(priced.problems[0]!); return; }
    if (!priced.bill || !settlement) { say('Check the bill'); return; }
    if (settlement.udhaar > 0 && !cart.customer) { say(t('sale.udhaar_choose_customer')); custRef.current?.focus(); return; }
    if (needsRx && !rx) { setDialog({ kind: 'prescription' }); return; }
    setBusy(true);
    setMessage(null);
    try {
      const payload = salePayload(cart, priced, settlement, { saleId: saleId.current, seq: nextSeq, drawerSessionId: ctx.open_shift!.drawer_session_id },
        extraApprovals, uuid);
      const withRx = rx ? { ...payload, prescription: { id: rx.id, patient_name: rx.patient_name, doctor_name: rx.doctor_name, pharmacist_id: rx.pharmacist_id } } : payload;
      const result = await backend.postSale(withRx, session.sessionId);
      const receipt = await backend.receipt(result.sale_id);
      setNextSeq((n) => n + 1);
      setDialog({ kind: 'receipt', data: receiptData(receipt, session.staff.name, cart.customer?.name ?? null, ctx.settings.receipt_footer) });
    } catch (err) {
      if (err instanceof PosError && err.needsApproval && err.detail) {
        const amount = err.detail === 'sales.discount' ? priced.bill.discountBp : err.detail === 'udhaar.give' ? settlement.udhaar : null;
        setDialog({ kind: 'approval', permission: err.detail, amount });
      } else {
        say(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const hold = async () => {
    if (!cart.lines.length) return;
    const held: HeldCart = { lines: cart.lines.map((l) => ({ product: l.product, unitId: l.unitId, qty: l.qty, discountPct: l.discountPct, priceOverride: l.priceOverride })),
                             billDiscount: cart.billDiscount, customer: cart.customer, note: cart.note };
    const label = cart.customer?.name ?? `${cart.lines[0]!.product.name}${cart.lines.length > 1 ? ` +${cart.lines.length - 1}` : ''}`;
    try {
      await backend.holdBill(uuid(), label, held, session.sessionId);
      resetSale();
      say(`${t('sale.hold')}: ${label}`, 'info');
    } catch (err) { say(errorText(err)); }
  };

  const showHeld = async () => {
    try { setDialog({ kind: 'held', bills: await backend.heldBills() }); } catch (err) { say(errorText(err)); }
  };

  const resume = async (bill: HeldBill) => {
    const held = bill.cart as HeldCart;
    try {
      const lines: CartLine[] = [];
      for (const l of held.lines) {
        lines.push({ key: uuid(), product: l.product, unitId: l.unitId, qty: l.qty, discountPct: l.discountPct, priceOverride: l.priceOverride,
                     batches: await backend.batches(l.product.product_id) });
      }
      await backend.resumeBill(bill, session.sessionId);
      resetSale();
      setCart({ ...emptyCart(), lines, billDiscount: held.billDiscount, customer: held.customer, note: held.note });
      setBillDiscountText(held.billDiscount ? String(held.billDiscount / 100) : '');
      setDialog(null);
    } catch (err) { say(errorText(err)); }
  };

  // ---- Keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      const line = cart.lines[selected];
      const focusCell = (col: 'qty' | 'price' | 'disc') => {
        if (!line) return;
        const el = rowInputs.current.get(`${line.key}:${col}`);
        el?.focus();
        el?.select();
      };
      const k = e.key;
      const handled = () => { e.preventDefault(); e.stopPropagation(); };
      if (k === 'F2') { handled(); searchRef.current?.focus(); searchRef.current?.select(); }
      else if (k === 'F3') { handled(); focusCell('qty'); }
      else if (k === 'F4') { handled(); custRef.current?.focus(); }
      else if (k === 'F5') { handled(); focusCell('price'); }
      else if (k === 'F6') { handled(); focusCell('disc'); }
      else if (k === 'F7') { handled(); billDiscRef.current?.focus(); billDiscRef.current?.select(); }
      else if (k === 'F8') { handled(); void hold(); }
      else if (k === 'F9') { handled(); void showHeld(); }
      else if (k === 'F10') {
        handled();
        const focusCash = () => { cashRef.current?.focus(); cashRef.current?.select(); };
        if (cart.method === 'cash') focusCash(); else { setCart((c) => ({ ...c, method: 'cash' })); window.setTimeout(focusCash, 0); }
      }
      else if (k === 'F12') { handled(); void complete(); }
      else if (e.ctrlKey && (k === 'u' || k === 'U')) {
        handled();
        if (line) {
          const units = line.product.units;
          const i = units.findIndex((u) => u.product_unit_id === line.unitId);
          updateLine(selected, { unitId: units[(i + 1) % units.length]!.product_unit_id, priceOverride: null });
        }
      } else if (e.ctrlKey && (k === 'm' || k === 'M')) {
        handled();
        setCart((c) => ({ ...c, method: METHODS[(METHODS.findIndex((m) => m.id === c.method) + 1) % METHODS.length]!.id }));
      } else if (e.ctrlKey && k === 'Delete') { handled(); if (line) removeLine(selected); }
      else if ((k === 'ArrowDown' || k === 'ArrowUp') && document.activeElement !== searchRef.current && document.activeElement !== custRef.current) {
        if (!cart.lines.length) return;
        handled();
        setSelected((s) => Math.max(0, Math.min(cart.lines.length - 1, s + (k === 'ArrowDown' ? 1 : -1))));
      } else if (k === 'Escape') {
        if (query) { setQuery(''); setResults([]); } else if (document.activeElement !== searchRef.current) { handled(); searchRef.current?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const customerStatus = (c: CustomerHit) =>
    !c.can_buy_on_account || c.udhaar_status === 'blocked' ? t('pos.udhaar_blocked')
      : c.udhaar_status === 'over_limit' ? t('pos.udhaar_over')
        : c.available_credit !== null ? t('pos.udhaar_up_to', { amount: rsShort(c.available_credit) }) : t('pos.udhaar_allowed');

  const unitLabel = (u: { unit_name: string; unit_name_ur: string | null }) => (lang === 'ur' && u.unit_name_ur ? u.unit_name_ur : u.unit_name);

  return (
    <div className="pos">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">M</span> MedFlow</div>
        <div className="topbar-place">{ctx.pharmacy} · {ctx.branch.name} · {ctx.device.name}</div>
        <div className="topbar-right">
          <span className="sync-pill">● {t('sync.synced')}</span>
          <span className="who">{session.staff.name}</span>
          <button type="button" className="link-btn" onClick={props.onToggleLang}>{t('pos.language')}</button>
          <button type="button" className="link-btn" onClick={() => setDialog({ kind: 'close_shift' })}>{t('pos.close_shift')}</button>
          <button type="button" className="link-btn" onClick={props.onSignOut}>{t('pos.lock')}</button>
        </div>
      </header>

      <div className="shift-bar">
        <span>{t('pos.shift_by', { name: ctx.open_shift?.opened_by_name ?? '' })} · {new Date(ctx.open_shift!.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <span className="muted">{t('pos.demo')}</span>
      </div>

      <main className="pos-main">
        <section className="bill-area">
          <div className="search-wrap">
            <span className="search-icon" aria-hidden>⌕</span>
            <input
              ref={searchRef}
              className="search"
              value={query}
              placeholder={t('pos.search_placeholder')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
                if (e.key === 'Enter' && results[active]) { e.preventDefault(); void addProduct(results[active]!, results[active]!.barcode_unit_id); }
              }}
              aria-label={t('pos.search_placeholder')}
            />
            {query.trim() && (results.length > 0 || searched === query.trim()) && (
              <ul className="results" role="listbox">
                {results.length === 0 && <li className="no-results">{t('pos.no_results', { q: query })}</li>}
                {results.map((p, i) => (
                  <li key={p.product_id} role="option" aria-selected={i === active} className={i === active ? 'active' : ''}
                      onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); void addProduct(p, p.barcode_unit_id); }}>
                    <div className="r-main">
                      <span className="r-name">{lang === 'ur' && p.name_ur ? p.name_ur : p.name}</span>
                      {p.rx_required && !p.is_controlled && <span className="tag rx">{t('pos.rx')}</span>}
                      {p.is_controlled && <span className="tag ctl">{t('pos.controlled')}</span>}
                      <div className="r-sub">{[p.generic, p.manufacturer, p.rack].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="r-side">
                      <span className="r-price">{p.units.map((u) => `${unitLabel(u)} ${rsShort(u.price ?? 0)}`).slice(0, 2).join(' · ')}</span>
                      <span className={p.stock_base > 0 ? 'r-stock' : 'r-stock out'}>
                        {p.stock_base > 0 ? t('pos.in_stock', { n: p.stock_base }) : t('pos.out_of_stock')}
                        {p.nearest_expiry ? ` · ${t('pos.expires', { date: shortDate(p.nearest_expiry) })}` : ''}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="shortcuts">{t('pos.shortcuts')}</div>

          <div className="cart">
            <div className="cart-head">
              <span>{t('pos.col_item')}</span><span>{t('pos.col_unit')}</span><span className="num">{t('pos.col_qty')}</span>
              <span className="num">{t('pos.col_price')}</span><span className="num">{t('pos.col_disc')}</span><span className="num">{t('pos.col_total')}</span><span />
            </div>
            {cart.lines.length === 0 && <div className="cart-empty">{t('pos.empty_cart')}</div>}
            {priced.rows.map((r, i) => {
              const l = r.line;
              const first = r.allocations[0];
              return (
                <div key={l.key} className={`cart-row${i === selected ? ' selected' : ''}${r.short > 0 ? ' short' : ''}`} onClick={() => setSelected(i)}>
                  <div className="c-item">
                    <div className="c-name">{lang === 'ur' && l.product.name_ur ? l.product.name_ur : l.product.name}
                      {l.product.is_controlled && <span className="tag ctl">{t('pos.controlled')}</span>}
                      {l.product.rx_required && !l.product.is_controlled && <span className="tag rx">{t('pos.rx')}</span>}
                    </div>
                    <div className="c-sub">
                      {first ? t('pos.batch', { batch: first.batchNumber + (r.allocations.length > 1 ? ` +${r.allocations.length - 1}` : ''), date: shortDate(first.expiry) })
                        : t('pos.out_of_stock')}
                    </div>
                  </div>
                  <select value={l.unitId} onChange={(e) => updateLine(i, { unitId: e.target.value, priceOverride: null })} aria-label={t('pos.col_unit')}>
                    {l.product.units.map((u) => <option key={u.product_unit_id} value={u.product_unit_id}>{unitLabel(u)}{u.factor > 1 ? ` (${u.factor})` : ''}</option>)}
                  </select>
                  <input className="num" inputMode="numeric" value={l.qty} aria-label={t('pos.col_qty')}
                         ref={(el) => { if (el) rowInputs.current.set(`${l.key}:qty`, el); }}
                         onChange={(e) => { const q = parseInt(e.target.value.replace(/\D/g, ''), 10); updateLine(i, { qty: Number.isFinite(q) && q > 0 ? q : 1 }); }}
                         onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); focusSearch(); } }} />
                  <input className="num" inputMode="decimal" aria-label={t('pos.col_price')}
                         ref={(el) => { if (el) rowInputs.current.set(`${l.key}:price`, el); }}
                         value={l.priceOverride !== null ? String(l.priceOverride / 100) : r.unitPrice !== null ? String(r.unitPrice / 100) : ''}
                         onChange={(e) => { const v = toPaisa(e.target.value); updateLine(i, { priceOverride: v }); }}
                         onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); focusSearch(); } }} />
                  <input className="num" inputMode="decimal" aria-label={t('pos.col_disc')} value={l.discountPct || ''} placeholder="0"
                         ref={(el) => { if (el) rowInputs.current.set(`${l.key}:disc`, el); }}
                         onChange={(e) => { const v = Number(e.target.value); updateLine(i, { discountPct: Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0 }); }}
                         onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); focusSearch(); } }} />
                  <span className="num c-total">{rs(r.total)}</span>
                  <button type="button" className="icon-btn" aria-label="Remove" onClick={(e) => { e.stopPropagation(); removeLine(i); }}>×</button>
                </div>
              );
            })}
          </div>
          {message && <div className={`message ${message.tone}`} role="status">{message.text}</div>}
          <div className="bill-footer">
            <button type="button" className="btn ghost" onClick={() => void hold()} disabled={!cart.lines.length}>{t('pos.hold')}</button>
            <button type="button" className="btn ghost" onClick={() => void showHeld()}>{t('pos.held')}</button>
            <button type="button" className="btn ghost" onClick={resetSale} disabled={!cart.lines.length}>{t('pos.clear')}</button>
            <input className="note" placeholder={t('pos.note')} value={cart.note} onChange={(e) => setCart((c) => ({ ...c, note: e.target.value }))} />
          </div>
        </section>

        <aside className="side">
          <div className="panel">
            <div className="panel-title">{t('pos.customer')}</div>
            {cart.customer ? (
              <div className="customer-chip">
                <div>
                  <div className="c-name">{cart.customer.name}</div>
                  <div className="muted small">{cart.customer.account_number} · {cart.customer.phone} · {customerStatus(cart.customer)}</div>
                </div>
                <button type="button" className="icon-btn" aria-label="Remove customer" onClick={() => setCart((c) => ({ ...c, customer: null }))}>×</button>
              </div>
            ) : (
              <div className="search-wrap">
                <input ref={custRef} className="cust-search" placeholder={t('pos.customer_search')} value={custQuery}
                       onChange={(e) => setCustQuery(e.target.value)}
                       onKeyDown={(e) => { if (e.key === 'Enter' && custResults[0]) { setCart((c) => ({ ...c, customer: custResults[0]! })); setCustQuery(''); setCustResults([]); } }} />
                {!custQuery && <div className="muted small walk-in">{t('pos.walk_in')}</div>}
                {custResults.length > 0 && (
                  <ul className="results small-results">
                    {custResults.map((c) => (
                      <li key={c.customer_id} onMouseDown={(e) => { e.preventDefault(); setCart((s) => ({ ...s, customer: c })); setCustQuery(''); setCustResults([]); }}>
                        <div className="r-main"><span className="r-name">{c.name}</span><div className="r-sub">{c.account_number} · {c.phone}</div></div>
                        <span className={`r-stock${c.udhaar_status === 'allowed' || c.udhaar_status === 'no_limit_set' ? '' : ' out'}`}>{customerStatus(c)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="panel totals">
            <div className="line"><span>{t('pos.items')}</span><span>{cart.lines.reduce((s, l) => s + l.qty, 0)}</span></div>
            <div className="line"><span>{t('pos.subtotal')}</span><span>{rs(priced.bill?.grossTotal ?? 0)}</span></div>
            {(priced.bill?.discountTotal ?? 0) > 0 && <div className="line"><span>{t('pos.line_discounts')}</span><span>− {rs(priced.bill!.discountTotal)}</span></div>}
            <label className="line field-inline">
              <span>{t('pos.bill_discount')}</span>
              <input ref={billDiscRef} inputMode="decimal" value={billDiscountText} placeholder="0"
                     onChange={(e) => { setBillDiscountText(e.target.value); setCart((c) => ({ ...c, billDiscount: toPaisa(e.target.value || '0') ?? 0 })); }}
                     onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); focusSearch(); } }} />
            </label>
            {(priced.bill?.rounding ?? 0) !== 0 && <div className="line muted"><span>{t('pos.rounding')}</span><span>{rs(priced.bill!.rounding)}</span></div>}
            <div className="grand"><span>{t('sale.total')}</span><span>{rs(grand)}</span></div>
          </div>

          <div className="panel">
            <div className="panel-title">{t('pos.payment_method')}</div>
            <div className="methods">
              {METHODS.map((m) => (
                <button key={m.id} type="button" className={`method${cart.method === m.id ? ' on' : ''}`} onClick={() => setCart((c) => ({ ...c, method: m.id }))}>
                  {t(m.key)}
                </button>
              ))}
            </div>
            {cart.method === 'cash' && (
              <div className="cash-row">
                <label className="field">
                  <span>{t('pos.cash_received')}</span>
                  <input ref={cashRef} inputMode="decimal" value={cashText} placeholder={grand ? String(cart.customer ? 0 : grand / 100) : ''}
                         onChange={(e) => { setCashText(e.target.value); setCart((c) => ({ ...c, cashReceived: e.target.value.trim() ? toPaisa(e.target.value) : null })); }}
                         onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void complete(); } }} />
                </label>
                <div className="change">
                  <span className="muted small">{t('sale.change')}</span>
                  <strong>{rs(settlement?.change ?? 0)}</strong>
                </div>
              </div>
            )}
            {settlement && settlement.udhaar > 0 && (
              <div className={`khata-note${cart.customer ? '' : ' warn'}`}>{t('pos.on_khata')}: {rs(settlement.udhaar)}{cart.customer ? ` · ${cart.customer.name}` : ` · ${t('sale.udhaar_choose_customer')}`}</div>
            )}
            <button type="button" className="btn pay" disabled={busy || !cart.lines.length} onClick={() => void complete()}>
              {busy ? t('pos.saving') : `${t('pos.complete')}`}
            </button>
          </div>
        </aside>
      </main>

      {dialog?.kind === 'approval' && (
        <ApprovalDialog {...props} permission={dialog.permission} amount={dialog.amount}
          summary={`${cart.lines.length} items · ${rs(grand)}${cart.customer ? ` · ${cart.customer.name}` : ''}`}
          onCancel={() => { setDialog(null); focusSearch(); }}
          onApproved={(id) => {
            const key = APPROVAL_KEY[dialog.permission] ?? dialog.permission;
            const next = { ...approvals, [key]: id };
            setApprovals(next);
            setDialog(null);
            void complete(next);
          }} />
      )}
      {dialog?.kind === 'prescription' && (
        <PrescriptionDialog {...props} needsPharmacist={needsPharmacist} onCancel={() => { setDialog(null); focusSearch(); }}
          onDone={(rx) => { setPrescription(rx); setDialog(null); void complete(approvals, rx); }} />
      )}
      {dialog?.kind === 'held' && <HeldDialog {...props} bills={dialog.bills} onResume={(b) => void resume(b)} onClose={() => { setDialog(null); focusSearch(); }} />}
      {dialog?.kind === 'receipt' && <ReceiptDialog {...props} receipt={dialog.data} onClose={() => { setDialog(null); resetSale(); }} />}
      {dialog?.kind === 'close_shift' && (
        <CloseShift {...props} session={session} onCancel={() => setDialog(null)}
          onClosed={async () => { setDialog(null); await props.reload(); props.onSignOut(); }} />
      )}
      <div id="print-area" aria-hidden />
    </div>
  );
}
