// `npm run agent -- <command>`
//   enroll --name <device>                 create this device's key pair and register its public key
//   cred add --app hr --username <email>   encrypt a credential here and upload ciphertext
//            [--label admin] [--origin http://127.0.0.1:4101]
//            password from KEYRUN_CRED_PASSWORD or stdin; TOTP seed from KEYRUN_CRED_TOTP (optional)
//   cred list                              credentials shared with this device (metadata only)
//   run [--once] [--headed]                claim and run tasks
//   whoami
import { createInterface } from 'node:readline';
import { config } from '../config.ts';
import { b64, newDeviceKeys, sodiumReady } from '../crypto/envelope.ts';
import { Agent } from './agent.ts';
import { ServerClient } from './client.ts';
import { deviceKeys, loadIdentity, saveIdentity } from './home.ts';
import { setCredential } from './vault.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const home = flag('home') ?? config.agentHome;

async function readSecretFromStdin(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  // Interactive: read without echoing.
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, output: undefined, terminal: true });
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

async function main() {
  const [cmd, sub] = argv;
  await sodiumReady();
  switch (cmd) {
    case 'enroll': {
      const name = flag('name') ?? 'my-laptop';
      const serverUrl = flag('server') ?? config.serverUrl;
      const keys = newDeviceKeys();
      const admin = new ServerClient(serverUrl, { adminToken: process.env.KEYRUN_ADMIN_TOKEN ?? config.adminToken });
      const { deviceId, token } = await admin.post<{ deviceId: string; token: string }>('/api/admin/devices', { name, publicKey: b64.enc(keys.publicKey) });
      await saveIdentity(home, { deviceId, token, name, serverUrl, publicKey: b64.enc(keys.publicKey), privateKey: b64.enc(keys.privateKey) });
      console.log(`Enrolled ${name} as ${deviceId}. Private key stays in ${home}/device.json (0600).`);
      break;
    }
    case 'cred': {
      const id = await loadIdentity(home);
      const client = new ServerClient(id.serverUrl, { device: { id: id.deviceId, token: id.token } });
      if (sub === 'list') {
        console.table(await client.get('/api/agent/credentials'));
        break;
      }
      if (sub !== 'add') throw new Error('usage: cred add --app <id> --username <email> | cred list');
      const appId = flag('app');
      const username = flag('username');
      if (!appId || !username) throw new Error('--app and --username are required');
      const apps = await client.get<Array<{ id: string; base_url: string }>>('/api/agent/apps');
      const app = apps.find((a) => a.id === appId);
      if (!app) throw new Error(`unknown app ${appId}`);
      const origin = flag('origin') ?? new URL(app.base_url).origin;
      const password = process.env.KEYRUN_CRED_PASSWORD ?? (await readSecretFromStdin(`Password for ${username}: `));
      const totpSecret = process.env.KEYRUN_CRED_TOTP || undefined;
      const out = await setCredential(client, { deviceId: id.deviceId, keys: deviceKeys(id) }, appId, flag('label') ?? 'admin', {
        username, password, totpSecret, allowedOrigins: [origin],
      });
      console.log(`Stored ${appId}/${flag('label') ?? 'admin'} v${out.version} (encrypted here; bound to ${origin}).`);
      break;
    }
    case 'run': {
      const agent = await new Agent({ home, headless: !has('headed') }).init();
      if (has('once')) {
        console.log(await agent.runOnce());
        break;
      }
      const ctrl = new AbortController();
      process.on('SIGINT', () => ctrl.abort());
      console.log(`Agent ${agent.deviceId} polling ${config.serverUrl}. Ctrl+C to stop.`);
      await agent.loop(ctrl.signal);
      break;
    }
    case 'whoami': {
      const id = await loadIdentity(home);
      console.log({ deviceId: id.deviceId, name: id.name, serverUrl: id.serverUrl, publicKey: id.publicKey });
      break;
    }
    default:
      console.log('usage: npm run agent -- enroll | cred add | cred list | run [--once] [--headed] | whoami');
  }
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
