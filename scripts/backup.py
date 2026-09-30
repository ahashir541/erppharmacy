from __future__ import annotations

import argparse
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a binary-safe PostgreSQL backup.")
    parser.add_argument("--destination", type=Path, default=Path("backups"))
    args = parser.parse_args()
    args.destination.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = args.destination / f"medical-erp-{timestamp}.dump"
    command = [
        "docker", "compose", "exec", "-T", "db", "sh", "-c",
        'pg_dump --format=custom --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"',
    ]
    with backup.open("wb") as output:
        result = subprocess.run(command, stdout=output, check=False)
    if result.returncode:
        backup.unlink(missing_ok=True)
        raise SystemExit(f"pg_dump failed with exit code {result.returncode}.")
    if backup.stat().st_size == 0:
        backup.unlink(missing_ok=True)
        raise SystemExit("pg_dump produced an empty backup.")
    print(f"Database backup created: {backup.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
