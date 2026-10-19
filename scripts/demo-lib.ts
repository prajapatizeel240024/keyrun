// Shared by `npm run demo` (all in one process) and `npm run demo:setup` (against running
// mocks + server). Everything the "device" does here (key generation, encryption) happens in
// this process; the server only ever receives public keys and ciphertext.
import { randomBytes } from 'node:crypto';
import { ServerClient, ApiError } from '../src/agent/client.ts';
import { deviceKeys, loadIdentity, saveIdentity, type DeviceIdentity } from '../src/agent/home.ts';
import { setCredential } from '../src/agent/vault.ts';
import { b64, newDeviceKeys, sodiumReady } from '../src/crypto/envelope.ts';
import { APP_NAMES, APP_ROLES } from '../src/mocks/index.ts';
import { APP_IDS, sampleMess, type AppId } from '../src/mocks/mess.ts';
import { seedPeople } from '../src/mocks/people.ts';
import { seededRng } from '../src/shared/rng.ts';
import type { CreatedTenant } from '../src/mocks/core.ts';

export async function demoSetup(opts: {
  serverUrl: string;
  adminToken: string;
  mockOrigins: Record<AppId, string>;
  agentHome: string;
  log?: (s: string) => void;
}): Promise<{ tenants: Record<AppId, CreatedTenant>; identity: DeviceIdentity }> {
  const log = opts.log ?? console.log;
  await sodiumReady();
  const admin = new ServerClient(opts.serverUrl, { adminToken: opts.adminToken });
  const rng = seededRng(Date.now());

  // 1. One fresh tenant per mock app, with realistic mess.
  const tenants = {} as Record<AppId, CreatedTenant>;
  for (const app of APP_IDS) {
    const res = await fetch(`${opts.mockOrigins[app]}/__admin/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId: `demo${randomBytes(3).toString('hex')}`,
        mess: sampleMess(app, rng),
        // Someone the demo can offboard, somewhere in the middle of the list.
        users: [...seedPeople(rng, 14, APP_ROLES[app]), LEAVER(app), ...seedPeople(rng, 10, APP_ROLES[app])],
      }),
    });
    if (!res.ok) throw new Error(`could not create a ${app} tenant: ${res.status}`);
    tenants[app] = (await res.json()) as CreatedTenant;
    await admin.put(`/api/admin/apps/${app}`, { name: APP_NAMES[app], baseUrl: tenants[app].baseUrl });
  }

  // 2. Policies: HR needs approval for destructive work, Helpdesk runs freely,
  //    Directory needs approval for everything admin and only runs 07:00–22:00 New York time.
  await admin.put('/api/admin/apps/hr/policy', { timezone: 'UTC', requireApproval: ['remove_user', 'rotate_password'] });
  await admin.put('/api/admin/apps/helpdesk/policy', { timezone: 'UTC', requireApproval: [] });
  await admin.put('/api/admin/apps/directory/policy', {
    timezone: 'America/New_York', allowedHours: { start: '07:00', end: '22:00' }, requireApproval: ['create_user', 'remove_user', 'rotate_password'],
  });

  // 3. This machine is the device: enroll it (or reuse a still-valid enrollment).
  let identity: DeviceIdentity | null = null;
  try {
    identity = await loadIdentity(opts.agentHome);
    await new ServerClient(opts.serverUrl, { device: { id: identity.deviceId, token: identity.token } }).get('/api/agent/credentials');
  } catch (e) {
    if (identity && !(e instanceof ApiError)) throw e;
    identity = null;
  }
  if (!identity) {
    const keys = newDeviceKeys();
    const { deviceId, token } = await admin.post<{ deviceId: string; token: string }>('/api/admin/devices', { name: 'demo-laptop', publicKey: b64.enc(keys.publicKey) });
    identity = { deviceId, token, name: 'demo-laptop', serverUrl: opts.serverUrl, publicKey: b64.enc(keys.publicKey), privateKey: b64.enc(keys.privateKey) };
    await saveIdentity(opts.agentHome, identity);
    log(`Enrolled device demo-laptop (${deviceId}); private key in ${opts.agentHome}/device.json`);
  }

  // 4. Encrypt each admin login on the device and upload only ciphertext.
  const device = new ServerClient(opts.serverUrl, { device: { id: identity.deviceId, token: identity.token } });
  for (const app of APP_IDS) {
    const t = tenants[app];
    await setCredential(device, { deviceId: identity.deviceId, keys: deviceKeys(identity) }, app, 'admin', {
      username: t.admin.email,
      password: t.admin.password,
      totpSecret: t.admin.totpSecret ?? undefined,
      allowedOrigins: [new URL(t.baseUrl).origin],
    });
  }

  // 5. A few tasks so the dashboard has something to show.
  const day = new Date().toISOString().slice(0, 16);
  const queue = (app: AppId, kind: string, params: Record<string, string>) =>
    admin.post('/api/admin/tasks', { app, kind, params, requestedBy: 'alex', idempotencyKey: `${app}:${kind}:${params.email ?? 'self'}:${day}` });
  await queue('hr', 'sign_in', {});
  await queue('helpdesk', 'create_user', { email: 'noor.tanaka.demo@example.test', name: 'Noor Tanaka', role: 'Agent' });
  await queue('hr', 'remove_user', { email: LEAVER('hr').email });
  await queue('directory', 'create_user', { email: 'wen.okafor.demo@example.test', name: 'Wen Okafor', role: 'Editor' });
  await queue('helpdesk', 'rotate_password', {});
  return { tenants, identity };
}

const LEAVER = (app: AppId) => ({ email: 'jordan.leaving@example.test', name: 'Jordan Leaving', role: APP_ROLES[app][0] });
