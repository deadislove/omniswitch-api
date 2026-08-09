-- OmniSwitch Payment Gateway - PostgreSQL Master Initialization
-- Cluster-level setup only (replication role, extensions). Application
-- schema (tables/indexes/triggers) is owned by TypeORM migrations
-- (src/database/migrations/) — this file must never create/alter tables,
-- or it will drift from and conflict with what migrations expect to find.

-- Create replication user for the replica
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replication_secret';
  END IF;
END
$$;

-- The REPLICATION LOGIN role attribute above is what actually grants
-- streaming-replication access — there is no PostgreSQL GRANT syntax for
-- replication privileges on a specific database (unlike MySQL's
-- `GRANT REPLICATION SLAVE`, which does not exist in PostgreSQL and was
-- removed from here after it was found to abort this entire init script
-- with a syntax error on every fresh cluster init).

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
