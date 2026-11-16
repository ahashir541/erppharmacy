// The neutral invoice the database hands to a tax adapter (app.tax_document). Money is in paisa,
// rates in basis points. Each authority's adapter turns it into its own request.

export interface TaxItem {
  code: string;
  name: string;
  quantity: number;
  unit: string;
  item_code: string;      // PCT / HS code from the tax category
  tax_rate_bp: number;
  sale_value: number;     // excluding tax
  tax: number;
  discount: number;
  total: number;
}

export interface TaxDocument {
  submission_id: string;
  provider: string;
  environment: 'sandbox' | 'production';
  sequence: number;
  document_type: 'sale' | 'return';
  invoice_number: string;
  original_invoice_number: string | null;
  original_authority_number: string | null;
  issued_at: string;
  seller: { ntn: string | null; strn: string | null; pos_id: string | null; registration_no: string | null; name: string; branch: string };
  buyer: { name: string | null; phone: string | null; cnic: string | null };
  payment_mode: string;
  items: TaxItem[];
  totals: { quantity: number; sale_value: number; tax: number; discount: number; total: number };
}

export interface TaxCredentials {
  token?: string;
  [key: string]: string | undefined;
}

export interface HttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** What happened to one document. */
export type TaxResult =
  | { accepted: true; authorityNumber: string; qr: string | null; response: unknown }
  | { accepted: false; retryable: boolean; error: string; response: unknown };

/**
 * One tax authority. A new authority (or country) is a new adapter; nothing in the counter or
 * the queue changes.
 */
export interface TaxProvider {
  readonly id: string;
  toRequest(doc: TaxDocument, credentials: TaxCredentials): HttpRequest;
  fromResponse(status: number, body: string): TaxResult;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ status: number; text(): Promise<string> }>;

/** Sends one document, turning network failures and timeouts into retryable results. */
export async function send(provider: TaxProvider, doc: TaxDocument, credentials: TaxCredentials, fetchFn: Fetch,
                           timeoutMs = 20_000): Promise<TaxResult> {
  let req: HttpRequest;
  try {
    req = provider.toRequest(doc, credentials);
  } catch (err) {
    return { accepted: false, retryable: false, error: (err as Error).message, response: null };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ctrl.signal });
    return provider.fromResponse(res.status, await res.text());
  } catch (err) {
    return { accepted: false, retryable: true, error: `Could not reach ${provider.id.toUpperCase()}: ${(err as Error).message}`, response: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Paisa as rupees with two decimals, the way authorities usually expect amounts. */
export const rupees = (paisa: number): number => Math.round(paisa) / 100;
