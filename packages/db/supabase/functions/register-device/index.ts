// Registers a pharmacy PC (counter) and gives it its own sign-in (D6, D11).
//
// Called by a pharmacy owner (signed in with 2FA) from the web app:
//   POST { branch_id, code, name }
// 1. public.register_device runs as the owner: checks devices.manage, the
//    plan's counter limit, and creates the device as 'pending'.
// 2. With the service role, create the PC's Supabase Auth user and attach it.
// 3. Return the PC's sign-in once. The owner enters it in the counter app's
//    setup screen, which stores it in Windows Credential Manager.
import { adminClient, callerClient, json, randomSecret, UUID } from '../_shared/http.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const owner = callerClient(req);
  if (!owner) return json({ error: 'Sign in first' }, 401);

  let body: { branch_id?: string; code?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body.branch_id || !UUID.test(body.branch_id) || !body.code || !body.name) {
    return json({ error: 'branch_id, code and name are required' }, 400);
  }

  const { data: reg, error: regError } = await owner.rpc('register_device', {
    p_branch: body.branch_id,
    p_code: body.code,
    p_name: body.name,
    p_kind: 'counter',
  });
  if (regError) {
    const status = regError.code === '42501' ? 403 : 400;
    return json({ error: regError.message, hint: regError.hint }, status);
  }
  const { device_id: deviceId, invoice_prefix: invoicePrefix } = reg as { device_id: string; invoice_prefix: string };

  const admin = adminClient();
  const email = `device-${deviceId}@devices.medflow.invalid`;
  const password = randomSecret();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { principal: 'device', device_id: deviceId },
  });
  if (createError || !created.user) {
    // The device stays 'pending' (it has no sign-in, so it can do nothing);
    // the owner can disable it and register again.
    return json({ error: 'Could not create the PC sign-in. Try again.', device_id: deviceId }, 502);
  }

  const { error: attachError } = await admin.rpc('platform_attach_device_auth', {
    p_device: deviceId,
    p_auth_user: created.user.id,
  });
  if (attachError) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: 'Could not activate the PC. Try again.', device_id: deviceId }, 502);
  }

  return json({ device_id: deviceId, invoice_prefix: invoicePrefix, sign_in: { email, password } }, 201);
});
