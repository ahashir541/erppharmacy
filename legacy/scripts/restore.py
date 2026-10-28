from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Restore a verified PostgreSQL dump during a maintenance window."
    )
    parser.add_argument("backup", type=Path)
    parser.add_argument(
        "--confirm-production-restore",
        action="store_true",
        help="Acknowledge that the current database will be overwritten.",
    )
    args = parser.parse_args()
    if not args.confirm_production_restore:
        parser.error("Restoring replaces live data; pass --confirm-production-restore.")
    backup = args.backup.resolve(strict=True)
    if not backup.is_file() or backup.stat().st_size == 0:
        parser.error("Backup must be a non-empty regular file.")

    verify_command = [
        "docker", "compose", "exec", "-T", "db", "sh", "-c",
        'pg_restore --list --no-owner',
    ]
    with backup.open("rb") as source:
        verification = subprocess.run(verify_command, stdin=source, check=False)
    if verification.returncode:
        raise SystemExit(
            "Backup archive verification failed; the live database was not changed."
        )

    pre_restore_backup = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().with_name("backup.py")),
            "--destination",
            str(backup.parent / "pre-restore"),
        ],
        check=False,
    )
    if pre_restore_backup.returncode:
        raise SystemExit(
            "Could not create a pre-restore backup; the live database was not changed."
        )

    stop = subprocess.run(["docker", "compose", "stop", "api", "proxy"], check=False)
    if stop.returncode:
        raise SystemExit("Could not stop API services; database restore was not started.")
    restore_command = [
        "docker", "compose", "exec", "-T", "db", "sh", "-c",
        'pg_restore --clean --if-exists --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"',
    ]
    with backup.open("rb") as source:
        result = subprocess.run(restore_command, stdin=source, check=False)
    if result.returncode:
        raise SystemExit(
            f"pg_restore failed with exit code {result.returncode}. "
            "Keep the maintenance window active and inspect the database."
        )
    start = subprocess.run(["docker", "compose", "up", "-d", "api", "proxy"], check=False)
    if start.returncode:
        raise SystemExit(
            "Database restore completed, but application services failed to restart."
        )
    print(f"Database restore completed from {backup}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
