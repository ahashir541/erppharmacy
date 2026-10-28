"""Add local subscription invoices and payment review.

Revision ID: 8acb43f1d562
Revises: 5f4a1c7b9d20
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "8acb43f1d562"
down_revision: Union[str, None] = "5f4a1c7b9d20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "stores",
        sa.Column("subscription_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "platform_subscription_invoices",
        sa.Column("store_id", sa.Uuid(), nullable=False),
        sa.Column("invoice_number", sa.String(length=80), nullable=False),
        sa.Column("plan_code", sa.String(length=40), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "DUE",
                "SUBMITTED",
                "REJECTED",
                "PAID",
                "VOID",
                name="subscriptioninvoicestatus",
                native_enum=False,
                length=20,
            ),
            server_default="DUE",
            nullable=False,
        ),
        sa.Column("payment_method", sa.String(length=24), nullable=True),
        sa.Column("payment_reference", sa.String(length=120), nullable=True),
        sa.Column("paid_amount", sa.Numeric(precision=14, scale=2), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reviewed_by_id", sa.Uuid(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["reviewed_by_id"], ["platform_operators.id"]),
        sa.ForeignKeyConstraint(["store_id"], ["stores.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("invoice_number", name="uq_platform_invoice_number"),
    )
    op.create_index(
        "ix_platform_invoice_store_created",
        "platform_subscription_invoices",
        ["store_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_platform_invoice_store_created", table_name="platform_subscription_invoices")
    op.drop_table("platform_subscription_invoices")
    op.drop_column("stores", "subscription_expires_at")
