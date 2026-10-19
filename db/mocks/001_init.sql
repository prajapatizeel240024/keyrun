-- The mock apps' own databases. One schema per app. These tables are the answer key:
-- evals check the real end state here, never the engine's own claim of success.
do $$
declare s text;
begin
  foreach s in array array['hr', 'helpdesk', 'directory'] loop
    execute format('create schema %I', s);

    execute format($f$
      create table %I.tenants (
        id                   text primary key,
        mess                 jsonb not null,
        admin_email          text not null,
        admin_name           text not null,
        admin_password_hash  text not null,
        totp_secret          text,
        totp_last_counter    bigint not null default 0,
        created_at           timestamptz not null default now()
      )$f$, s);

    -- No unique index on email on purpose: a sloppy app that allows duplicates is exactly
    -- what lets the answer key catch an engine that creates a user twice.
    execute format($f$
      create table %I.users (
        id          bigserial primary key,
        tenant_id   text not null references %I.tenants(id) on delete cascade,
        email       text not null,
        name        text not null,
        role        text not null,
        status      text not null default 'active',
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now()
      )$f$, s, s);
    execute format('create index on %I.users (tenant_id, lower(email))', s);

    execute format($f$
      create table %I.audit (
        id         bigserial primary key,
        tenant_id  text not null references %I.tenants(id) on delete cascade,
        action     text not null,
        target     text,
        at         timestamptz not null default now()
      )$f$, s, s);
    execute format('create index on %I.audit (tenant_id, action)', s);
  end loop;
end $$;
