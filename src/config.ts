// Central config. Every listener binds to 127.0.0.1; there is no option to change that.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file is fine; defaults below match docker-compose.yml.
}

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

export const HOST = '127.0.0.1';

export const config = {
  databaseUrl: env('KEYRUN_DATABASE_URL', 'postgres://keyrun:keyrun@127.0.0.1:5432/keyrun'),
  mocksDatabaseUrl: env('KEYRUN_MOCKS_DATABASE_URL', 'postgres://keyrun:keyrun@127.0.0.1:5432/keyrun_mocks'),
  testDatabaseUrl: env('KEYRUN_TEST_DATABASE_URL', 'postgres://keyrun:keyrun@127.0.0.1:5432/keyrun_test'),
  serverPort: Number(env('KEYRUN_SERVER_PORT', '4000')),
  adminToken: env('KEYRUN_ADMIN_TOKEN', 'dev-admin-token'),
  ports: {
    hr: Number(env('KEYRUN_HR_PORT', '4101')),
    helpdesk: Number(env('KEYRUN_HELPDESK_PORT', '4102')),
    directory: Number(env('KEYRUN_DIRECTORY_PORT', '4103')),
  },
  serverUrl: env('KEYRUN_SERVER_URL', 'http://127.0.0.1:4000'),
  agentHome: env('KEYRUN_AGENT_HOME', '.keyrun-agent'),
};

/** Refuse to talk to anything that is not loopback. Used by the agent and the engine. */
export function assertLoopbackUrl(url: string): void {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
    throw new Error(`Refusing non-loopback URL ${u.origin}: Keyrun only automates local mock apps.`);
  }
}
