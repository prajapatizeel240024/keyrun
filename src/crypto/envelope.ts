// End-to-end credential encryption with libsodium. Runs only on devices; the server imports
// nothing from here.
//
//   credential JSON ──XChaCha20-Poly1305(DEK, nonce, AAD)──▶ ciphertext       (stored on server)
//   DEK ──crypto_box_seal(device X25519 public key)──▶ sealed DEK per device    (stored on server)
//
// The AAD binds the ciphertext to (credential id, app, version), so a server that swaps blobs
// between credentials or replays an old version gets a decryption failure, not a wrong password.
import sodium from 'libsodium-wrappers-sumo';

export async function sodiumReady(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

export type DeviceKeys = { publicKey: Uint8Array; privateKey: Uint8Array };

/** What a credential holds once decrypted. `allowedOrigins` is set on the device and the server cannot change it. */
export type CredentialSecret = {
  username: string;
  password: string;
  totpSecret?: string;
  allowedOrigins: string[];
};

export type Recipient = { deviceId: string; publicKey: Uint8Array };

export type SealedCredential = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  sealedKeys: Array<{ deviceId: string; sealedDek: Uint8Array }>;
};

export class CredentialDecryptError extends Error {}

export function newDeviceKeys(): DeviceKeys {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export function credentialAad(credentialId: string, appId: string, version: number): Uint8Array {
  return sodium.from_string(`keyrun.credential.v1|${credentialId}|${appId}|${version}`);
}

export function sealCredential(secret: CredentialSecret, aad: Uint8Array, recipients: Recipient[]): SealedCredential {
  if (!recipients.length) throw new Error('need at least one recipient device');
  const dek = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plaintext = sodium.from_string(JSON.stringify(secret));
  try {
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, dek);
    const sealedKeys = recipients.map((r) => ({ deviceId: r.deviceId, sealedDek: sodium.crypto_box_seal(dek, r.publicKey) }));
    return { ciphertext, nonce, sealedKeys };
  } finally {
    sodium.memzero(dek);
    sodium.memzero(plaintext);
  }
}

export function openCredential(
  blob: { ciphertext: Uint8Array; nonce: Uint8Array; sealedDek: Uint8Array },
  aad: Uint8Array,
  keys: DeviceKeys,
): CredentialSecret {
  let dek: Uint8Array;
  try {
    dek = sodium.crypto_box_seal_open(blob.sealedDek, keys.publicKey, keys.privateKey);
  } catch {
    throw new CredentialDecryptError('this device cannot unseal the data key');
  }
  try {
    const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, blob.ciphertext, aad, blob.nonce, dek);
    try {
      return JSON.parse(sodium.to_string(pt)) as CredentialSecret;
    } finally {
      sodium.memzero(pt);
    }
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    throw new CredentialDecryptError('ciphertext failed authentication (tampered, swapped, or wrong version)');
  } finally {
    sodium.memzero(dek);
  }
}

/** Share an existing credential with another device without re-encrypting it. */
export function resealForDevice(sealedDek: Uint8Array, mine: DeviceKeys, other: Uint8Array): Uint8Array {
  const dek = sodium.crypto_box_seal_open(sealedDek, mine.publicKey, mine.privateKey);
  try {
    return sodium.crypto_box_seal(dek, other);
  } finally {
    sodium.memzero(dek);
  }
}

export const b64 = {
  enc: (u: Uint8Array) => Buffer.from(u).toString('base64'),
  dec: (s: string) => new Uint8Array(Buffer.from(s, 'base64')),
};
