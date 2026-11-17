// The printed bill, designed: the shop's name large, clear item lines, a strong total, change and
// udhaar called out, the batch and expiry of every medicine, and a short footer. The same markup
// is shown on screen and printed on 80 mm (or 58 mm) thermal paper. No cost or profit, ever.
import type { ReceiptData } from '@medflow/core';

const METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', jazzcash: 'JazzCash', easypaisa: 'Easypaisa', bank_transfer: 'Bank transfer', loyalty: 'Points' };
const amt = (p: number) => (p / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const exp = (iso?: string | null) => (iso ? `${iso.slice(5, 7)}/${iso.slice(2, 4)}` : '');

export function ReceiptView(props: { r: ReceiptData; width?: 58 | 80; returnNote?: string | null }) {
  const { r } = props;
  const items = r.lines.reduce((s, l) => s + l.qty, 0);
  const subtotal = r.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  return (
    <div className={`receipt paper-${props.width ?? 80}`}>
      <header className="rc-head">
        <div className="rc-shop">{r.pharmacy}</div>
        <div className="rc-branch">{r.branch.name}</div>
        {r.branch.address && <div className="rc-small">{r.branch.address}</div>}
        {r.branch.phone && <div className="rc-small">☎ {r.branch.phone}</div>}
      </header>
      <div className="rc-meta">
        <div><span>Bill</span><strong>{r.invoiceNumber}</strong></div>
        <div><span>Date</span><span>{r.soldAt}</span></div>
        {r.cashier && <div><span>Served by</span><span>{r.cashier}</span></div>}
        {r.customer && <div><span>Customer</span><strong>{r.customer}</strong></div>}
      </div>
      <table className="rc-items">
        <thead><tr><th>Item</th><th className="n">Qty</th><th className="n">Rate</th><th className="n">Amount</th></tr></thead>
        <tbody>
          {r.lines.map((l, i) => (
            <tr key={i}>
              <td>
                <div className="rc-name">{l.name}{l.strength ? ` ${l.strength}` : ''}</div>
                <div className="rc-batch">{l.unit}{l.batch ? ` · B.${l.batch}` : ''}{l.expiry ? ` · Exp ${exp(l.expiry)}` : ''}{l.discount ? ` · −${amt(l.discount)}` : ''}</div>
              </td>
              <td className="n">{l.qty}</td>
              <td className="n">{amt(l.unitPrice)}</td>
              <td className="n">{amt(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rc-totals">
        <div><span>Items</span><span>{items}</span></div>
        <div><span>Subtotal</span><span>{amt(subtotal)}</span></div>
        {r.discountTotal > 0 && <div><span>Discount</span><span>−{amt(r.discountTotal)}</span></div>}
        {r.rounding !== 0 && <div><span>Rounding</span><span>{r.rounding > 0 ? '+' : '−'}{amt(Math.abs(r.rounding))}</span></div>}
        <div className="rc-grand"><span>TOTAL</span><span>Rs {amt(r.grandTotal)}</span></div>
        {r.payments.map((p, i) => <div key={i}><span>{METHOD[p.method] ?? p.method}</span><span>{amt(p.amount)}</span></div>)}
        {r.change > 0 && <div className="rc-strong"><span>Change</span><span>{amt(r.change)}</span></div>}
      </div>
      {r.udhaar > 0 && <div className="rc-udhaar">CREDIT (UDHAAR) · Rs {amt(r.udhaar)}<div className="rc-small">added to {r.customer ?? 'the customer'}'s khata</div></div>}
      {props.returnNote && <div className="rc-udhaar">{props.returnNote}</div>}
      <footer className="rc-foot">
        {r.footer && <div>{r.footer}</div>}
        <div className="rc-thanks">Thank you · شکریہ</div>
        <div className="rc-powered">MedFlow</div>
      </footer>
    </div>
  );
}

/** Prints just this receipt (the print stylesheet hides everything else). */
export function printReceipt(node: HTMLElement | null, width: 58 | 80) {
  const area = document.getElementById('print-area');
  if (!area || !node) return;
  area.innerHTML = node.outerHTML;
  area.dataset.paper = String(width);
  window.print();
}
