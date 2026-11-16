// The sender: claims the next documents from the database queue (public.tax_claim_batch, which
// only ever gives out the next unanswered document of each counter), sends each to its authority,
// and records the answer (public.tax_record_result). Run by the tax-worker Edge Function every
// minute; safe to run twice at once.
import { MockTaxProvider } from './mock.ts';
import { send, type Fetch, type TaxCredentials, type TaxDocument, type TaxProvider, type TaxResult } from './types.ts';

export interface Claimed {
  id: string;
  tenant_id: string;
  provider: string;
  attempt: number;
  vault_secret_id: string | null;
  document: TaxDocument;
}

export interface TaxQueue {
  claim(limit: number): Promise<Claimed[]>;
  record(id: string, result: TaxResult): Promise<void>;
  credentials(vaultSecretId: string | null): Promise<TaxCredentials>;
}

export interface WorkerOptions {
  queue: TaxQueue;
  providers: Record<string, TaxProvider>;
  fetch: Fetch;
  batchSize?: number;
  /** Stop after this many rounds (each round sends at most one document per counter). */
  maxRounds?: number;
}

export async function runTaxWorker(opts: WorkerOptions): Promise<{ sent: number; accepted: number; failed: number }> {
  const stats = { sent: 0, accepted: 0, failed: 0 };
  for (let round = 0; round < (opts.maxRounds ?? 100); round++) {
    const batch = await opts.queue.claim(opts.batchSize ?? 50);
    if (batch.length === 0) break;
    // Different counters are independent, so they go out in parallel; each counter has at most
    // one document in a batch, which keeps its order.
    await Promise.all(batch.map(async (c) => {
      const provider = opts.providers[c.provider];
      let result: TaxResult;
      if (!provider) {
        result = { accepted: false, retryable: true, error: `No sender for ${c.provider} yet`, response: null };
      } else if (provider instanceof MockTaxProvider) {
        result = provider.submit(c.document);
      } else {
        result = await send(provider, c.document, await opts.queue.credentials(c.vault_secret_id), opts.fetch);
      }
      stats.sent++;
      if (result.accepted) stats.accepted++; else stats.failed++;
      await opts.queue.record(c.id, result);
    }));
  }
  return stats;
}

/** Arguments for public.tax_record_result. */
export function recordArgs(id: string, r: TaxResult) {
  return r.accepted
    ? { p_submission: id, p_accepted: true, p_authority_number: r.authorityNumber, p_qr: r.qr, p_response: r.response ?? null, p_error: null, p_retryable: true }
    : { p_submission: id, p_accepted: false, p_authority_number: null, p_qr: null, p_response: r.response ?? null, p_error: r.error, p_retryable: r.retryable };
}
