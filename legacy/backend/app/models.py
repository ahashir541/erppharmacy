from datetime import date, datetime, timezone
from decimal import Decimal
from enum import StrEnum
from uuid import UUID, uuid4

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import Uuid

from app.database import Base


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class UserRole(StrEnum):
    OWNER = "owner"
    ADMIN = "admin"
    MANAGER = "manager"
    PHARMACIST = "pharmacist"
    CASHIER = "cashier"
    ACCOUNTANT = "accountant"


class MovementType(StrEnum):
    RECEIPT = "receipt"
    SALE = "sale"
    ADJUSTMENT = "adjustment"
    RETURN = "return"
    TRANSFER = "transfer"


class PaymentMethod(StrEnum):
    CASH = "cash"
    CARD = "card"
    MOBILE_WALLET = "mobile_wallet"
    CREDIT = "credit"
    BANK = "bank"


class PurchaseStatus(StrEnum):
    DRAFT = "draft"
    ORDERED = "ordered"
    PARTIALLY_RECEIVED = "partially_received"
    RECEIVED = "received"
    CANCELLED = "cancelled"


class TenantStatus(StrEnum):
    TRIAL = "trial"
    ACTIVE = "active"
    SUSPENDED = "suspended"
    CANCELLED = "cancelled"


class SubscriptionInvoiceStatus(StrEnum):
    DUE = "due"
    SUBMITTED = "submitted"
    REJECTED = "rejected"
    PAID = "paid"
    VOID = "void"


class BaseModel(Base):
    __abstract__ = True

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc, nullable=False
    )


class Store(BaseModel):
    __tablename__ = "stores"

    name: Mapped[str] = mapped_column(String(180), nullable=False)
    address: Mapped[str] = mapped_column(Text, default="", nullable=False)
    phone: Mapped[str] = mapped_column(String(40), default="", nullable=False)
    tax_number: Mapped[str] = mapped_column(String(80), default="", nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="PKR", nullable=False)
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(7, 3), default=Decimal("0"))
    expiry_alert_days: Mapped[int] = mapped_column(default=90, nullable=False)
    invoice_prefix: Mapped[str] = mapped_column(String(12), default="INV", nullable=False)
    tenant_status: Mapped[TenantStatus] = mapped_column(
        Enum(TenantStatus, native_enum=False, length=20),
        default=TenantStatus.ACTIVE,
        server_default="ACTIVE",
        nullable=False,
    )
    plan_code: Mapped[str] = mapped_column(
        String(40), default="starter", server_default="starter", nullable=False
    )
    trial_ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    subscription_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    subscription_reference: Mapped[str] = mapped_column(
        String(120), default="", server_default="", nullable=False
    )

    users: Mapped[list["User"]] = relationship(back_populates="store")


class User(BaseModel):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("email", name="uq_user_email"),)

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(140), nullable=False)
    email: Mapped[str] = mapped_column(String(254), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    auth_version: Mapped[int] = mapped_column(
        default=0, server_default="0", nullable=False
    )
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, native_enum=False, length=20), default=UserRole.CASHIER
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    store: Mapped[Store] = relationship(back_populates="users")


class PlatformOperator(BaseModel):
    __tablename__ = "platform_operators"
    __table_args__ = (UniqueConstraint("email", name="uq_platform_operator_email"),)

    name: Mapped[str] = mapped_column(String(140), nullable=False)
    email: Mapped[str] = mapped_column(String(254), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    auth_version: Mapped[int] = mapped_column(
        default=0, server_default="0", nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class PlatformAuditLog(BaseModel):
    __tablename__ = "platform_audit_logs"

    operator_id: Mapped[UUID] = mapped_column(ForeignKey("platform_operators.id"), nullable=False)
    store_id: Mapped[UUID | None] = mapped_column(ForeignKey("stores.id"))
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    details: Mapped[str] = mapped_column(Text, nullable=False)


class PlatformSubscriptionInvoice(BaseModel):
    __tablename__ = "platform_subscription_invoices"
    __table_args__ = (
        UniqueConstraint("invoice_number", name="uq_platform_invoice_number"),
        Index("ix_platform_invoice_store_created", "store_id", "created_at"),
    )

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    invoice_number: Mapped[str] = mapped_column(String(80), nullable=False)
    plan_code: Mapped[str] = mapped_column(String(40), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[SubscriptionInvoiceStatus] = mapped_column(
        Enum(SubscriptionInvoiceStatus, native_enum=False, length=20),
        default=SubscriptionInvoiceStatus.DUE,
        server_default="DUE",
        nullable=False,
    )
    payment_method: Mapped[str | None] = mapped_column(String(24))
    payment_reference: Mapped[str | None] = mapped_column(String(120))
    paid_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by_id: Mapped[UUID | None] = mapped_column(ForeignKey("platform_operators.id"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str] = mapped_column(Text, default="", nullable=False)


class Product(BaseModel):
    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("store_id", "sku", name="uq_product_store_sku"),
        UniqueConstraint("store_id", "barcode", name="uq_product_store_barcode"),
        Index("ix_products_store_name", "store_id", "name"),
    )

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    sku: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(180), nullable=False)
    generic_name: Mapped[str] = mapped_column(String(180), default="", nullable=False)
    category: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    manufacturer: Mapped[str] = mapped_column(String(140), default="", nullable=False)
    barcode: Mapped[str | None] = mapped_column(String(80))
    unit: Mapped[str] = mapped_column(String(40), default="pack", nullable=False)
    pack_size: Mapped[int] = mapped_column(default=1, nullable=False)
    purchase_price: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    sale_price: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(7, 3), default=0)
    reorder_level: Mapped[Decimal] = mapped_column(Numeric(14, 3), default=0)
    shelf_location: Mapped[str] = mapped_column(String(80), default="", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    batches: Mapped[list["Batch"]] = relationship(back_populates="product")


class Supplier(BaseModel):
    __tablename__ = "suppliers"
    __table_args__ = (UniqueConstraint("store_id", "name", name="uq_supplier_store_name"),)

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(180), nullable=False)
    contact_name: Mapped[str] = mapped_column(String(140), default="", nullable=False)
    email: Mapped[str | None] = mapped_column(String(254))
    phone: Mapped[str | None] = mapped_column(String(40))
    address: Mapped[str] = mapped_column(Text, default="", nullable=False)
    opening_balance: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Customer(BaseModel):
    __tablename__ = "customers"
    __table_args__ = (UniqueConstraint("store_id", "phone", name="uq_customer_store_phone"),)

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(180), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(40))
    email: Mapped[str | None] = mapped_column(String(254))
    address: Mapped[str] = mapped_column(Text, default="", nullable=False)
    credit_limit: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    opening_balance: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Batch(BaseModel):
    __tablename__ = "batches"
    __table_args__ = (
        UniqueConstraint("store_id", "product_id", "batch_number", name="uq_batch_number"),
        Index("ix_batches_fefo", "store_id", "product_id", "expiry_date"),
    )

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    product_id: Mapped[UUID] = mapped_column(ForeignKey("products.id"), nullable=False)
    supplier_id: Mapped[UUID | None] = mapped_column(ForeignKey("suppliers.id"))
    batch_number: Mapped[str] = mapped_column(String(80), nullable=False)
    expiry_date: Mapped[date] = mapped_column(Date, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(14, 3), default=0)
    purchase_price: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    product: Mapped[Product] = relationship(back_populates="batches")


class Purchase(BaseModel):
    __tablename__ = "purchases"
    __table_args__ = (UniqueConstraint("store_id", "purchase_number", name="uq_purchase_number"),)

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    supplier_id: Mapped[UUID] = mapped_column(ForeignKey("suppliers.id"), nullable=False)
    purchase_number: Mapped[str] = mapped_column(String(80), nullable=False)
    supplier_invoice: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    status: Mapped[PurchaseStatus] = mapped_column(
        Enum(PurchaseStatus, native_enum=False, length=30), default=PurchaseStatus.DRAFT
    )
    subtotal: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    tax_total: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    total: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    paid: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    due_date: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)


class PurchaseLine(BaseModel):
    __tablename__ = "purchase_lines"

    purchase_id: Mapped[UUID] = mapped_column(ForeignKey("purchases.id"), nullable=False)
    product_id: Mapped[UUID] = mapped_column(ForeignKey("products.id"), nullable=False)
    batch_number: Mapped[str] = mapped_column(String(80), nullable=False)
    expiry_date: Mapped[date] = mapped_column(Date, nullable=False)
    quantity_ordered: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    quantity_received: Mapped[Decimal] = mapped_column(Numeric(14, 3), default=0)
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(7, 3), default=0)


class Sale(BaseModel):
    __tablename__ = "sales"
    __table_args__ = (
        UniqueConstraint("store_id", "invoice_number", name="uq_sale_invoice"),
        Index("uq_sale_idempotency_key", "store_id", "idempotency_key", unique=True),
    )

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    customer_id: Mapped[UUID | None] = mapped_column(ForeignKey("customers.id"))
    invoice_number: Mapped[str] = mapped_column(String(80), nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    idempotency_fingerprint: Mapped[str | None] = mapped_column(String(64))
    cashier_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    prescription_reference: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="completed", nullable=False)
    subtotal: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    discount: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    tax_total: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    total: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    cost_total: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)


class SaleLine(BaseModel):
    __tablename__ = "sale_lines"

    sale_id: Mapped[UUID] = mapped_column(ForeignKey("sales.id"), nullable=False)
    product_id: Mapped[UUID] = mapped_column(ForeignKey("products.id"), nullable=False)
    product_name: Mapped[str] = mapped_column(String(180), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    discount: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(7, 3), default=0)
    cost_total: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)


class Payment(BaseModel):
    __tablename__ = "payments"

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    sale_id: Mapped[UUID | None] = mapped_column(ForeignKey("sales.id"))
    purchase_id: Mapped[UUID | None] = mapped_column(ForeignKey("purchases.id"))
    method: Mapped[PaymentMethod] = mapped_column(Enum(PaymentMethod, native_enum=False, length=20))
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    reference: Mapped[str] = mapped_column(String(120), default="", nullable=False)


class StockMovement(BaseModel):
    __tablename__ = "stock_movements"
    __table_args__ = (Index("ix_movements_store_created", "store_id", "created_at"),)

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    batch_id: Mapped[UUID | None] = mapped_column(ForeignKey("batches.id"))
    product_id: Mapped[UUID] = mapped_column(ForeignKey("products.id"), nullable=False)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    movement_type: Mapped[MovementType] = mapped_column(
        Enum(MovementType, native_enum=False, length=20)
    )
    quantity_change: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    previous_quantity: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    new_quantity: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    reason: Mapped[str] = mapped_column(String(240), default="", nullable=False)
    reference: Mapped[str] = mapped_column(String(120), default="", nullable=False)


class Expense(BaseModel):
    __tablename__ = "expenses"

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    category: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(String(240), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    payment_method: Mapped[PaymentMethod] = mapped_column(
        Enum(PaymentMethod, native_enum=False, length=20), default=PaymentMethod.CASH
    )


class CashShift(BaseModel):
    __tablename__ = "cash_shifts"

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    opening_cash: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    expected_closing_cash: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    actual_closing_cash: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    variance: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)


class LedgerEntry(BaseModel):
    __tablename__ = "ledger_entries"

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    customer_id: Mapped[UUID | None] = mapped_column(ForeignKey("customers.id"))
    supplier_id: Mapped[UUID | None] = mapped_column(ForeignKey("suppliers.id"))
    account: Mapped[str] = mapped_column(String(80), nullable=False)
    entry_type: Mapped[str] = mapped_column(String(30), nullable=False)
    debit: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    credit: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    reference: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    description: Mapped[str] = mapped_column(String(240), default="", nullable=False)
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)


class AuditLog(BaseModel):
    __tablename__ = "audit_logs"

    store_id: Mapped[UUID] = mapped_column(ForeignKey("stores.id"), nullable=False)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(80), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(80), nullable=False)
    details: Mapped[str] = mapped_column(Text, default="", nullable=False)
