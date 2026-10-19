// Device-side credential operations. Plaintext exists only in this process's memory.
import { randomUUID } from 'node:crypto';
import {
  b64, credentialAad, openCredential, sealCredential, sodiumReady, type CredentialSecret, type DeviceKeys,
} from '../crypto/envelope.ts';
import { ApiError, type ServerClient } from './client.ts';

export type CredentialEnvelope = { id: string; appId: string; label: string; version: number; ciphertext: string; nonce: string; sealedDek: string };

export async function decryptEnvelope(env: CredentialEnvelope, keys: DeviceKeys): Promise<CredentialSecret> {
  await sodiumReady();
  return openCredential(
    { ciphertext: b64.dec(env.ciphertext), nonce: b64.dec(env.nonce), sealedDek: b64.dec(env.sealedDek) },
    credentialAad(env.id, env.appId, env.version),
    keys,
  );
}

/** Encrypt on the device and upload ciphertext. Returns the stored version. */
export async function uploadCredential(
  client: ServerClient,
  me: { deviceId: string; keys: DeviceKeys },
  c: { id?: string; appId: string; label: string; version: number; secret: CredentialSecret },
): Promise<{ id: string; version: number }> {
  await sodiumReady();
  const id = c.id ?? randomUUID();
  const sealed = sealCredential(c.secret, credentialAad(id, c.appId, c.version), [{ deviceId: me.deviceId, publicKey: me.keys.publicKey }]);
  const out = await client.put<{ version: number }>(`/api/agent/credentials/${id}`, {
    id,
    appId: c.appId,
    label: c.label,
    version: c.version,
    ciphertext: b64.enc(sealed.ciphertext),
    nonce: b64.enc(sealed.nonce),
    sealedKeys: sealed.sealedKeys.map((k) => ({ deviceId: k.deviceId, sealedDek: b64.enc(k.sealedDek) })),
  });
  return { id, version: out.version };
}

/** Add a credential, or store a new version if one with this label exists. */
export async function setCredential(
  client: ServerClient,
  me: { deviceId: string; keys: DeviceKeys },
  appId: string,
  label: string,
  secret: CredentialSecret,
): Promise<{ id: string; version: number }> {
  const mine = await client.get<Array<{ id: string; app_id: string; label: string; version: number }>>('/api/agent/credentials');
  const existing = mine.find((x) => x.app_id === appId && x.label === label);
  try {
    return await uploadCredential(client, me, { id: existing?.id, appId, label, version: (existing?.version ?? 0) + 1, secret });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && !existing) {
      throw new Error(`A credential "${label}" for ${appId} exists but is not shared with this device.`);
    }
    throw e;
  }
}
