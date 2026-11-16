// Sends queued invoices to the tax authorities (Phase 7). Run every minute by Supabase cron:
//   select cron.schedule('tax-worker', '* * * * *', $$ select net.http_post(
//     url := '<project>/functions/v1/tax-worker', headers := '{"Authorization": "Bearer <cron secret>"}') $$);
// It also runs the scheduled checks (stuck queue, licences, offline PCs, expiry, low stock) every
// 15 minutes. Credentials come from Supabase Vault through the service role and never leave here.
import { FbrPosProvider, recordArgs, runTaxWorker, type Claimed, type TaxCredentials } from '../../../../tax/src/index.ts';
import { adminClient, json } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('Authorization') !== `Bearer ${secret}`) return json({ error: 'Not allowed' }, 401);
  const db = adminClient();

  const stats = await runTaxWorker({
    providers: { fbr: new FbrPosProvider() },
    fetch: (url, init) => fetch(url, init),
    queue: {
      claim: async (limit) => {
        const { data, error } = await db.rpc('tax_claim_batch', { p_limit: limit });
        if (error) throw new Error(error.message);
        return (data ?? []) as Claimed[];
      },
      record: async (id, result) => {
        const { error } = await db.rpc('tax_record_result', recordArgs(id, result));
        if (error) throw new Error(error.message);
      },
      credentials: async (vaultSecretId): Promise<TaxCredentials> => {
        if (!vaultSecretId) return {};
        const { data, error } = await db.schema('vault').from('decrypted_secrets').select('decrypted_secret').eq('id', vaultSecretId).single();
        if (error || !data) return {};
        try {
          return JSON.parse(data.decrypted_secret as string) as TaxCredentials;
        } catch {
          return { token: data.decrypted_secret as string };
        }
      },
    },
    maxRounds: 20,
  });

  let checks = null;
  if (new Date().getUTCMinutes() % 15 === 0) {
    const { data } = await db.rpc('run_scheduled_checks');
    checks = data;
  }
  return json({ ...stats, checks });
});
