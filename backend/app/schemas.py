from datetime import date, datetime
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints

NonEmpty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
Money = Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=2)]
Quantity = Annotated[Decimal, Field(gt=0, max_digits=14, decimal_places=3)]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: Annotated[str, StringConstraints(min_length=12, max_length=128)]


class PlatformPasswordChange(BaseModel):
    current_password: str
    new_password: Annotated[str, StringConstraints(min_length=14, max_length=128)]


class PlatformTenantCreate(BaseModel):
    pharmacy_name: NonEmpty
    administrator_name: NonEmpty
    administrator_email: EmailStr
    administrator_password: Annotated[str, StringConstraints(min_length=14, max_length=128)]
    plan_code: Annotated[str, StringConstraints(pattern=r"^(starter|professional|enterprise)$")] = "starter"
    trial_days: int = Field(default=30, ge=0, le=90)


class TenantStatusUpdate(BaseModel):
    status: str
    plan_code: Annotated[str, StringConstraints(pattern=r"^(starter|professional|enterprise)$")]
    trial_days: int | None = Field(default=None, ge=1, le=90)


class PlatformInvoiceCreate(BaseModel):
    plan_code: Annotated[str, StringConstraints(pattern=r"^(starter|professional|enterprise)$")]
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    duration_days: int = Field(ge=1, le=730)
    due_days: int = Field(default=7, ge=1, le=30)


class PlatformInvoicePaymentSubmit(BaseModel):
    method: Annotated[str, StringConstraints(pattern=r"^(jazzcash|easypaisa|bank_transfer|manual)$")]
    paid_amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    reference: Annotated[str, StringConstraints(strip_whitespace=True, min_length=4, max_length=120)]


class PlatformInvoiceReview(BaseModel):
    status: Annotated[str, StringConstraints(pattern=r"^(paid|rejected|void)$")]
    note: str = ""


class UserCreate(BaseModel):
    name: NonEmpty
    email: EmailStr
    password: Annotated[str, StringConstraints(min_length=12, max_length=128)]
    role: str = "cashier"


class UserRead(ORMModel):
    id: UUID
    name: str
    email: EmailStr
    role: str
    store_id: UUID


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserRead


class ProductCreate(BaseModel):
    sku: NonEmpty
    name: NonEmpty
    generic_name: str = ""
    category: str = ""
    manufacturer: str = ""
    barcode: str | None = None
    unit: str = "pack"
    pack_size: int = Field(default=1, ge=1)
    purchase_price: Money = Decimal("0")
    sale_price: Money = Decimal("0")
    tax_rate: Decimal = Field(default=Decimal("0"), ge=0, le=100)
    reorder_level: Decimal = Field(default=Decimal("0"), ge=0)
    shelf_location: str = ""


class ProductUpdate(ProductCreate):
    is_active: bool = True


class ProductRead(ORMModel):
    id: UUID
    sku: str
    name: str
    generic_name: str
    category: str
    manufacturer: str
    barcode: str | None
    unit: str
    pack_size: int
    purchase_price: Decimal | None
    sale_price: Decimal
    tax_rate: Decimal
    reorder_level: Decimal
    shelf_location: str
    is_active: bool
    stock: Decimal = Decimal("0")
    inventory_value: Decimal | None = Decimal("0")


class BatchReceipt(BaseModel):
    product_id: UUID
    batch_number: NonEmpty
    expiry_date: date
    quantity: Quantity
    purchase_price: Money
    supplier_id: UUID | None = None
    reference: str = ""


class StockAdjustment(BaseModel):
    batch_id: UUID
    direction: str
    quantity: Quantity
    reason_code: str
    notes: str = ""


class BatchRead(ORMModel):
    id: UUID
    product_id: UUID
    supplier_id: UUID | None
    batch_number: str
    expiry_date: date
    quantity: Decimal
    purchase_price: Decimal | None
    received_at: datetime


class StockMovementRead(ORMModel):
    id: UUID
    product_id: UUID
    batch_id: UUID | None
    movement_type: str
    quantity_change: Decimal
    previous_quantity: Decimal
    new_quantity: Decimal
    reason: str
    reference: str
    created_at: datetime


class SupplierCreate(BaseModel):
    name: NonEmpty
    contact_name: str = ""
    email: EmailStr | None = None
    phone: str = ""
    address: str = ""
    opening_balance: Money = Decimal("0")


class SupplierRead(ORMModel):
    id: UUID
    name: str
    contact_name: str
    email: str | None
    phone: str | None
    address: str
    opening_balance: Decimal | None
    is_active: bool


class CustomerCreate(BaseModel):
    name: NonEmpty
    phone: str = ""
    email: EmailStr | None = None
    address: str = ""
    credit_limit: Money = Decimal("0")
    opening_balance: Money = Decimal("0")


class LedgerPayment(BaseModel):
    amount: Money
    method: str = "cash"
    reference: str = ""
    description: str = ""


class JournalLine(BaseModel):
    account: NonEmpty
    debit: Money = Decimal("0")
    credit: Money = Decimal("0")


class JournalEntryCreate(BaseModel):
    reference: str = ""
    description: NonEmpty
    lines: Annotated[list[JournalLine], Field(min_length=2)]


class CustomerRead(ORMModel):
    id: UUID
    name: str
    phone: str | None
    email: str | None
    address: str
    credit_limit: Decimal | None
    opening_balance: Decimal | None
    is_active: bool


class SaleLineCreate(BaseModel):
    product_id: UUID
    quantity: Quantity
    discount: Money = Decimal("0")


class PaymentInput(BaseModel):
    method: str
    amount: Money
    reference: str = ""


class SaleCreate(BaseModel):
    customer_id: UUID | None = None
    lines: Annotated[list[SaleLineCreate], Field(min_length=1, max_length=500)]
    payments: Annotated[list[PaymentInput], Field(min_length=1, max_length=10)]
    invoice_discount: Money = Decimal("0")
    prescription_reference: str = ""


class SaleLineRead(ORMModel):
    id: UUID
    product_id: UUID
    product_name: str
    quantity: Decimal
    unit_price: Decimal
    discount: Decimal
    tax_rate: Decimal
    cost_total: Decimal


class SaleRead(ORMModel):
    id: UUID
    customer_id: UUID | None
    invoice_number: str
    status: str
    subtotal: Decimal
    discount: Decimal
    tax_total: Decimal
    total: Decimal
    cost_total: Decimal
    created_at: datetime


class SaleDetail(SaleRead):
    lines: list[SaleLineRead]


class PurchaseLineCreate(BaseModel):
    product_id: UUID
    batch_number: NonEmpty
    expiry_date: date
    quantity_ordered: Quantity
    unit_cost: Money


class PurchaseCreate(BaseModel):
    supplier_id: UUID
    supplier_invoice: str = ""
    due_date: date | None = None
    notes: str = ""
    lines: Annotated[list[PurchaseLineCreate], Field(min_length=1)]


class PurchaseRead(ORMModel):
    id: UUID
    supplier_id: UUID
    purchase_number: str
    supplier_invoice: str
    status: str
    subtotal: Decimal
    tax_total: Decimal
    total: Decimal
    paid: Decimal
    due_date: date | None
    notes: str
    created_at: datetime


class PurchaseReceive(BaseModel):
    line_id: UUID
    quantity: Quantity


class ExpenseCreate(BaseModel):
    category: NonEmpty
    description: NonEmpty
    amount: Money
    payment_method: str = "cash"


class ShiftOpen(BaseModel):
    opening_cash: Money
    notes: str = ""


class ShiftClose(BaseModel):
    actual_closing_cash: Money
    notes: str = ""


class StoreUpdate(BaseModel):
    name: NonEmpty
    address: str = ""
    phone: str = ""
    tax_number: str = ""
    currency: Annotated[str, StringConstraints(min_length=3, max_length=3)] = "PKR"
    tax_rate: Decimal = Field(default=Decimal("0"), ge=0, le=100)
    expiry_alert_days: int = Field(default=90, ge=1, le=365)
    invoice_prefix: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=12)] = "INV"


class AuditLogRead(ORMModel):
    id: UUID
    user_id: UUID
    action: str
    entity_type: str
    entity_id: str
    details: str
    created_at: datetime
