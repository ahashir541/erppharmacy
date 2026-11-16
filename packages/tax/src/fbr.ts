// FBR POS integration (federal sales tax), as described in FBR's POS integration guide for
// retailers: the POS posts each invoice as JSON with a bearer token and gets back FBR's invoice
// number, which is printed on the bill with a QR code.
//
// IMPORTANT: confirm the field names, URLs and codes against FBR's current specification and with
// a tax adviser before switching a pharmacy to production (brief, Compliance). Everything that may
// change is in this one file.
import { rupees, type HttpRequest, type TaxCredentials, type TaxDocument, type TaxProvider, type TaxResult } from './types.ts';

export const FBR_URLS = {
  sandbox: 'https://esp.fbr.gov.pk:8244/FBR/v1/api/Live/PostData',
  production: 'https://gw.fbr.gov.pk/imsp/v1/api/Live/PostData',
} as const;

/** FBR's payment mode numbers. */
const PAYMENT_MODE: Record<string, number> = { cash: 1, card: 2, gift: 3, loyalty: 4, mixed: 5, cheque: 6 };
/** Invoice types: 1 = new sale, 3 = refund (return). */
const INVOICE_TYPE = { sale: 1, return: 3 } as const;

export class FbrPosProvider implements TaxProvider {
  readonly id = 'fbr';
  private readonly urls: { sandbox: string; production: string };
  constructor(urls: { sandbox: string; production: string } = FBR_URLS) {
    this.urls = urls;
  }

  toRequest(doc: TaxDocument, credentials: TaxCredentials): HttpRequest {
    if (!credentials.token) throw new Error('FBR token is not set for this pharmacy');
    if (!doc.seller.pos_id) throw new Error('FBR POS ID is not set for this pharmacy');
    const type = INVOICE_TYPE[doc.document_type];
    const sign = doc.document_type === 'return' ? -1 : 1;
    const body = {
      InvoiceNumber: '',
      POSID: Number(doc.seller.pos_id),
      USIN: doc.invoice_number,
      RefUSIN: doc.original_authority_number ?? doc.original_invoice_number ?? null,
      DateTime: localDateTime(doc.issued_at),
      BuyerNTN: '',
      BuyerCNIC: doc.buyer.cnic ?? '',
      BuyerName: doc.buyer.name ?? '',
      BuyerPhoneNumber: doc.buyer.phone ?? '',
      TotalBillAmount: sign * rupees(doc.totals.total),
      TotalQuantity: sign * doc.totals.quantity,
      TotalSaleValue: sign * rupees(doc.totals.sale_value),
      TotalTaxCharged: sign * rupees(doc.totals.tax),
      Discount: rupees(doc.totals.discount),
      FurtherTax: 0,
      PaymentMode: PAYMENT_MODE[doc.payment_mode] ?? (doc.payment_mode === 'credit' ? PAYMENT_MODE.cash : PAYMENT_MODE.mixed),
      InvoiceType: type,
      Items: doc.items.map((i) => ({
        ItemCode: i.code,
        ItemName: i.name.slice(0, 100),
        Quantity: sign * i.quantity,
        PCTCode: i.item_code,
        TaxRate: i.tax_rate_bp / 100,
        SaleValue: sign * rupees(i.sale_value),
        TotalAmount: sign * rupees(i.total),
        TaxCharged: sign * rupees(i.tax),
        Discount: rupees(i.discount),
        FurtherTax: 0,
        InvoiceType: type,
        RefUSIN: doc.original_invoice_number ?? null,
      })),
    };
    return {
      url: this.urls[doc.environment],
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.token}` },
      body: JSON.stringify(body),
    };
  }

  fromResponse(status: number, text: string): TaxResult {
    if (status >= 500 || status === 408 || status === 429) {
      return { accepted: false, retryable: true, error: `FBR is busy or down (HTTP ${status})`, response: text };
    }
    let json: { InvoiceNumber?: string; Code?: string | number; Response?: string; Errors?: unknown };
    try {
      json = JSON.parse(text);
    } catch {
      return { accepted: false, retryable: true, error: `FBR sent an unreadable answer (HTTP ${status})`, response: text };
    }
    if (status === 401 || status === 403) {
      return { accepted: false, retryable: true, error: 'FBR refused the token: check the POS registration', response: json };
    }
    if (String(json.Code) === '100' && json.InvoiceNumber) {
      return { accepted: true, authorityNumber: json.InvoiceNumber, qr: json.InvoiceNumber, response: json };
    }
    return { accepted: false, retryable: false, error: json.Response ?? `FBR code ${json.Code ?? status}`, response: json };
  }
}

/** FBR wants the shop's local time, "YYYY-MM-DD HH:mm:ss" (Pakistan, UTC+5). */
export function localDateTime(iso: string): string {
  const d = new Date(Date.parse(iso) + 5 * 3_600_000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
