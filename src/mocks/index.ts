import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HOST } from '../config.ts';
import { createTenant, type CreatedTenant, type SeedUser } from './core.ts';
import { directoryApp } from './directory.ts';
import { helpdeskApp } from './helpdesk.ts';
import { hrApp } from './hr.ts';
import type { AppId, Mess } from './mess.ts';

export type MockApps = {
  origins: Record<AppId, string>;
  createTenant(app: AppId, opts: { mess: Mess; users: SeedUser[]; adminPassword?: string; tenantId?: string }): Promise<CreatedTenant>;
  close(): Promise<void>;
};

export const APP_NAMES: Record<AppId, string> = { hr: 'Mock HR', helpdesk: 'Mock Helpdesk', directory: 'Mock Directory' };

/** Valid roles in each app (what the create-user form offers). */
export const APP_ROLES: Record<AppId, string[]> = {
  hr: ['Employee', 'Manager', 'Admin'],
  helpdesk: ['Agent', 'Supervisor', 'Admin'],
  directory: ['Reader', 'Editor', 'Owner'],
};

/** Start all three mock apps on 127.0.0.1. Port 0 picks free ports (used by tests and evals). */
export async function startMocks(ports: Record<AppId, number> = { hr: 0, helpdesk: 0, directory: 0 }): Promise<MockApps> {
  const builders: Record<AppId, () => ReturnType<typeof hrApp>> = { hr: hrApp, helpdesk: helpdeskApp, directory: directoryApp };
  const servers: Server[] = [];
  const origins = {} as Record<AppId, string>;
  for (const app of Object.keys(builders) as AppId[]) {
    const server = await new Promise<Server>((resolve, reject) => {
      const s = builders[app]().listen(ports[app], HOST, () => resolve(s));
      s.on('error', reject);
    });
    servers.push(server);
    origins[app] = `http://${HOST}:${(server.address() as AddressInfo).port}`;
  }
  return {
    origins,
    createTenant: (app, opts) => createTenant(app, origins[app], opts),
    close: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((r) => {
        s.closeAllConnections();
        s.close(() => r());
      })));
    },
  };
}
