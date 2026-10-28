// Sends the invitation email to a newly onboarded pharmacy owner.
//
// Called by the platform owner (signed in with 2FA) from the admin console,
// right after public.platform_provision_tenant:
//   POST { owner_user_id }
// The owner opens the email, sets a password, sets up 2FA, and the web app
// calls public.accept_owner_invite.
import { adminClient, callerClient, json, UUID } from '../_shared/http.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const caller = callerClient(req);
  if (!caller) return json({ error: 'Sign in first' }, 401);

  // RLS lets only an active platform admin with 2FA read platform_admins.
  const { data: me } = await caller.from('platform_admins').select('id').limit(1).maybeSingle();
  if (!me) return json({ error: 'Platform admin sign-in with 2FA is required' }, 403);

  let body: { owner_user_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body.owner_user_id || !UUID.test(body.owner_user_id)) {
    return json({ error: 'owner_user_id is required' }, 400);
  }

  const admin = adminClient();
  const { data: owner, error: ownerError } = await admin
    .from('users')
    .select('id, tenant_id, email, kind, status, auth_user_id')
    .eq('id', body.owner_user_id)
    .maybeSingle();
  if (ownerError || !owner || owner.kind !== 'owner' || owner.status !== 'invited' || !owner.email) {
    return json({ error: 'No pending owner invitation found' }, 404);
  }
  if (owner.auth_user_id) return json({ error: 'This owner already has a login' }, 409);

  const siteUrl = Deno.env.get('MEDFLOW_WEB_URL') ?? '';
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(owner.email, {
    data: { active_tenant_id: owner.tenant_id },
    redirectTo: siteUrl ? `${siteUrl}/accept-invite` : undefined,
  });
  if (inviteError || !invited.user) {
    // An existing login (owner of another pharmacy) is linked from the
    // console instead; that flow arrives with the console in Phase 8.
    return json({ error: inviteError?.message ?? 'Invitation failed' }, 409);
  }

  const { error: linkError } = await admin.rpc('platform_link_owner_auth', {
    p_user: owner.id,
    p_auth_user: invited.user.id,
  });
  if (linkError) return json({ error: 'Invitation sent but linking failed; contact support' }, 500);

  await admin.from('platform_audit_log').insert({
    admin_id: me.id,
    tenant_id: owner.tenant_id,
    action: 'tenant.owner_invited',
    details: { owner_user_id: owner.id },
  });
  return json({ invited: true }, 200);
});
