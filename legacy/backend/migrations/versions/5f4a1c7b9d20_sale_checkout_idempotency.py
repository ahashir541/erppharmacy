"""Persist POS idempotency keys to prevent duplicate checkout transactions.

Revision ID: 5f4a1c7b9d20
Revises: e2e806741b12
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "5f4a1c7b9d20"
down_revision: Union[str, None] = "e2e806741b12"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sales", sa.Column("idempotency_key", sa.String(length=128), nullable=True))
    op.add_column("sales", sa.Column("idempotency_fingerprint", sa.String(length=64), nullable=True))
    op.create_index(
        "uq_sale_idempotency_key",
        "sales",
        ["store_id", "idempotency_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_sale_idempotency_key", table_name="sales")
    op.drop_column("sales", "idempotency_fingerprint")
    op.drop_column("sales", "idempotency_key")
