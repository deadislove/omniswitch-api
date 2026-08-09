#!/bin/bash
# Runs once, only on a fresh (empty) data directory, as part of the official
# postgres image's docker-entrypoint-initdb.d hook. Appends a pg_hba.conf rule
# permitting the replicator role to open streaming-replication connections
# from other containers on the compose network — the default generated
# pg_hba.conf only covers loopback for the `replication` pseudo-database, and
# a plain `host all all all scram-sha-256` entry does not match replication
# connections.
set -e
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
