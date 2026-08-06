#!/usr/bin/env bash
set -euo pipefail

# Backs up both Postgres databases:
#   geocoding       -- streets/street_names/address_points (TIGER + Maine
#                      E911 data). Reconstructable from public sources via
#                      geocoding.annual_update, but a dump is much faster
#                      to restore than a full re-ingest.
#   geocoding_users -- real customer accounts, service keys, quota usage,
#                      feedback. NOT reconstructable from anywhere else --
#                      this is the one that actually matters.
#
# Uses pg_dump's custom format (-F c): compressed, and restorable
# selectively (single table, schema-only, etc.) via pg_restore, unlike a
# plain .sql dump. Keeps the last RETENTION_DAYS days of backups in
# BACKUP_DIR, deleting older ones on every run.
#
# This writes to local disk on THIS machine -- it protects against a bad
# migration, an accidental DELETE, or disk corruption on the database
# files themselves, but not against losing the whole machine. Once this
# is deployed to Lightsail, either point BACKUP_DIR at a mounted volume
# that's itself backed up, sync it off-box (e.g. to S3), or use
# Lightsail's own Database automated-snapshot feature instead of this
# script entirely.
#
# Meant to run periodically -- see ops/geocoding-backup.timer (or
# ops/crontab.example for a plain-cron alternative).
#
#   ops/backup-databases.sh [backup-dir]   (default: ~/backups/geocoding)
#
# To restore:
#   pg_restore -U my_ai -h /var/run/postgresql -d <dbname> --clean --if-exists /path/to/dump
#   (create the target database first if restoring into a fresh one)

BACKUP_DIR="${1:-$HOME/backups/geocoding}"
RETENTION_DAYS=14
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SOCKET_DIR="/var/run/postgresql"

mkdir -p "$BACKUP_DIR"

for DB in geocoding geocoding_users; do
  DEST="$BACKUP_DIR/${DB}_${TIMESTAMP}.dump"
  echo "Backing up $DB -> $DEST"
  pg_dump -U my_ai -h "$SOCKET_DIR" -F c -f "$DEST" "$DB"
done

echo "Deleting backups older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -name "*.dump" -mtime "+$RETENTION_DAYS" -delete

echo "Current backups in $BACKUP_DIR:"
ls -lh "$BACKUP_DIR"
