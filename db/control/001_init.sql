-- Control plane. This database must never hold a plaintext secret:
-- test/no-plaintext.test.ts scans every row of every table to prove it.

create table devices (
  id            uuid primary key,
  name          text not null,
  public_key    bytea not null,          -- X25519 public key. The private key never leaves the device.
  token_hash    bytea not null,          -- sha256(device bearer token)
  enrolled_at   timestamptz not null default now(),
  last_seen_at  timestamptz
);

create table apps (
  id        text primary key,            -- 'hr' | 'helpdesk' | 'directory'
  name      text not null,
  base_url  text not null,
  policy    jsonb not null default '{}'  -- allowed hours, which kinds need approval
);

create table workflows (
  id          bigserial primary key,
  app_id      text references apps(id),  -- null for unassigned recorder drafts
  kind        text not null,
  version     int not null,
  definition  jsonb not null,
  source      text not null default 'repo',   -- repo | editor | recorder
  created_at  timestamptz not null default now(),
  unique (app_id, kind, version)
);

-- Envelope encryption: credential JSON is sealed with a random data key (XChaCha20-Poly1305),
-- and that data key is sealed to each device's public key. The server only ever sees ciphertext.
create table credentials (
  id                 uuid primary key,   -- chosen by the device so it can be bound into the AAD
  app_id             text not null references apps(id),
  label              text not null,
  version            int not null,
  ciphertext         bytea not null,
  nonce              bytea not null,
  created_by_device  uuid references devices(id),
  updated_at         timestamptz not null default now(),
  unique (app_id, label)
);

create table credential_keys (
  credential_id  uuid not null references credentials(id) on delete cascade,
  device_id      uuid not null references devices(id) on delete cascade,
  version        int not null,
  sealed_dek     bytea not null,
  primary key (credential_id, device_id)
);

create type task_status as enum ('pending_approval', 'queued', 'leased', 'succeeded', 'failed', 'rejected', 'dead');

create table tasks (
  id                uuid primary key default gen_random_uuid(),
  idempotency_key   text not null unique,
  app_id            text not null references apps(id),
  kind              text not null,
  workflow_id       bigint not null references workflows(id),
  credential_id     uuid not null references credentials(id),
  target_device_id  uuid references devices(id),
  params            jsonb not null default '{}',   -- non-secret inputs only
  status            task_status not null,
  attempts          int not null default 0,
  max_attempts      int not null default 3,
  lease_id          uuid,
  lease_device_id   uuid references devices(id),
  lease_expires_at  timestamptz,
  not_before        timestamptz not null default now(),
  requested_by      text not null,
  approved_by       text,
  result            jsonb,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index tasks_claimable on tasks (not_before, created_at) where status in ('queued', 'leased');

create table task_events (
  id         bigserial primary key,
  task_id    uuid not null references tasks(id) on delete cascade,
  at         timestamptz not null default now(),
  type       text not null,
  device_id  uuid,
  attempt    int,
  detail     jsonb not null default '{}'
);
create index task_events_by_task on task_events (task_id, id);
