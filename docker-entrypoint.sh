#!/bin/sh
set -eu

DATABASE_PATH="${DATABASE_PATH:-/app/data/sales.db}"
case "$DATABASE_PATH" in
  */*) DATA_DIR="${DATABASE_PATH%/*}" ;;
  *) DATA_DIR="/app" ;;
esac

# Named volumes and previously-created bind mounts keep their old ownership.
# Repair the mounted directory before dropping privileges for the Node process.
mkdir -p "$DATA_DIR" "$DATA_DIR/backups"
chown -R app:app "$DATA_DIR"

exec gosu app "$@"
