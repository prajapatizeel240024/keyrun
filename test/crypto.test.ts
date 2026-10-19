import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  CredentialDecryptError, credentialAad, newDeviceKeys, openCredential, resealForDevice, sealCredential, sodiumReady, type CredentialSecret,
} from '../src/crypto/envelope.ts';

const secret: CredentialSecret = { username: 'admin@acme.example.test', password: 'Tr0ub4dor&3-horse', totpSecret: 'JBSWY3DPEHPK3PXP', allowedOrigins: ['http://127.0.0.1:4101'] };

before(async () => {
  await sodiumReady();
});

test('a device can open what was sealed to it', () => {
  const me = newDeviceKeys();
  const aad = credentialAad('c1', 'hr', 1);
  const s = sealCredential(secret, aad, [{ deviceId: 'd1', publicKey: me.publicKey }]);
  assert.equal(s.nonce.length, 24);
  assert.equal(s.sealedKeys[0].sealedDek.length, 80);
  assert.ok(!Buffer.from(s.ciphertext).toString('latin1').includes(secret.password));
  assert.deepEqual(openCredential({ ciphertext: s.ciphertext, nonce: s.nonce, sealedDek: s.sealedKeys[0].sealedDek }, aad, me), secret);
});

test('another device cannot open it', () => {
  const me = newDeviceKeys();
  const other = newDeviceKeys();
  const aad = credentialAad('c1', 'hr', 1);
  const s = sealCredential(secret, aad, [{ deviceId: 'd1', publicKey: me.publicKey }]);
  assert.throws(() => openCredential({ ciphertext: s.ciphertext, nonce: s.nonce, sealedDek: s.sealedKeys[0].sealedDek }, aad, other), CredentialDecryptError);
});

test('the AAD stops a server from swapping blobs between credentials or replaying old versions', () => {
  const me = newDeviceKeys();
  const s = sealCredential(secret, credentialAad('c1', 'hr', 1), [{ deviceId: 'd1', publicKey: me.publicKey }]);
  const blob = { ciphertext: s.ciphertext, nonce: s.nonce, sealedDek: s.sealedKeys[0].sealedDek };
  assert.throws(() => openCredential(blob, credentialAad('c2', 'hr', 1), me), CredentialDecryptError, 'different credential id');
  assert.throws(() => openCredential(blob, credentialAad('c1', 'helpdesk', 1), me), CredentialDecryptError, 'different app');
  assert.throws(() => openCredential(blob, credentialAad('c1', 'hr', 2), me), CredentialDecryptError, 'stale version served as current');
});

test('flipping one ciphertext bit is detected', () => {
  const me = newDeviceKeys();
  const aad = credentialAad('c1', 'hr', 1);
  const s = sealCredential(secret, aad, [{ deviceId: 'd1', publicKey: me.publicKey }]);
  const tampered = new Uint8Array(s.ciphertext);
  tampered[5] ^= 1;
  assert.throws(() => openCredential({ ciphertext: tampered, nonce: s.nonce, sealedDek: s.sealedKeys[0].sealedDek }, aad, me), CredentialDecryptError);
});

test('a credential can be shared with a second device without re-encrypting it', () => {
  const me = newDeviceKeys();
  const laptop2 = newDeviceKeys();
  const aad = credentialAad('c1', 'hr', 1);
  const s = sealCredential(secret, aad, [{ deviceId: 'd1', publicKey: me.publicKey }]);
  const forLaptop2 = resealForDevice(s.sealedKeys[0].sealedDek, me, laptop2.publicKey);
  assert.deepEqual(openCredential({ ciphertext: s.ciphertext, nonce: s.nonce, sealedDek: forLaptop2 }, aad, laptop2), secret);
});
