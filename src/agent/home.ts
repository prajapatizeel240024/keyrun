// The agent's on-device state: identity (device id, bearer token, X25519 key pair) and journal.
// In production the private key would live in the OS keychain / TPM / Secure Enclave instead of a
// 0600 file; see DESIGN.md.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { b64, type DeviceKeys } from '../crypto/envelope.ts';

export type DeviceIdentity = {
  deviceId: string;
  token: string;
  name: string;
  serverUrl: string;
  publicKey: string; // base64
  privateKey: string; // base64
};

export const identityFile = (home: string) => path.join(home, 'device.json');

export async function loadIdentity(home: string): Promise<DeviceIdentity> {
  try {
    return JSON.parse(await readFile(identityFile(home), 'utf8'));
  } catch {
    throw new Error(`No device identity in ${home}. Run: npm run agent -- enroll --name <device name>`);
  }
}

export async function saveIdentity(home: string, id: DeviceIdentity): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(identityFile(home), JSON.stringify(id, null, 2), { mode: 0o600 });
  await chmod(identityFile(home), 0o600);
}

export function deviceKeys(id: DeviceIdentity): DeviceKeys {
  return { publicKey: b64.dec(id.publicKey), privateKey: b64.dec(id.privateKey) };
}
