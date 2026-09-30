import hashlib
import json
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.database import get_db
from app.dependencies import get_current_user, require_roles
from app.models import (
    AuditLog,
    Batch,
    CashShift,
    Customer,
    Expense,
    LedgerEntry,
    MovementType,
    Payment,
    PaymentMethod,
    Product,
    Purchase,
    PurchaseLine,
    PurchaseStatus,
    Sale,
    SaleLine,
    StockMovement,
    Store,
    Supplier,
    User,
    UserRole,
)
from app.schemas import (
    CustomerCreate,
    CustomerRead,
    ExpenseCreate,
    JournalEntryCreate,
    LedgerPayment,
    PaymentInput,
    PurchaseCreate,
    PurchaseRead,
    PurchaseReceive,
    SaleCreate,
    SaleDetail,
    SaleLineRead,
    SaleRead,
    ShiftClose,
    ShiftOpen,
    StoreUpdate,
    SupplierCreate,
    SupplierRead,
    UserCreate,
    UserRead,
)
from app.security import hash_password
from app.timeutils import get_store_timezone, local_date, local_date_bounds

router = APIRouter(prefix="/api", tags=["operations"])
ADMIN_ROLES = (UserRole.OWNER, UserRole.ADMIN, UserRole.ACCOUNTANT)
STOCK_ROLES = (UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.PHARMACIST)
CENT = Decimal("0.01")


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def sale_fingerprint(payload: SaleCreate, user: User) -> str:
    request = {
        "store_id": str(user.store_id),
        "cashier_id": str(user.id),
        "sale": payload.model_dump(mode="json"),
    }
    serialized = json.dumps(request, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(serialized).hexdigest()


def build_sale_detail(db: Session, sale: Sale) -> SaleDetail:
    lines = db.scalars(
        select(SaleLine)
        .where(SaleLine.sale_id == sale.id)
        .order_by(SaleLine.created_at, SaleLine.id)
    ).all()
    return SaleDetail(
        **SaleRead.model_validate(sale).model_dump(),
        lines=[SaleLineRead.model_validate(line) for line in lines],
    )


@router.get("/users", response_model=list[UserRead])
def list_users(
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(UserRole.OWNER)),
) -> list[User]:
    return list(
        db.scalars(
            select(User)
            .where(User.store_id == user.store_id)
            .order_by(User.name)
        ).all()
    )


@router.post("/users", response_model=UserRead, status_code=201)
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(UserRole.OWNER)),
) -> User:
    try:
        role = UserRole(payload.role)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Choose a valid user role.") from error
    if role in {UserRole.OWNER, UserRole.ADMIN}:
        raise HTTPException(
            status_code=422,
            detail="Only the pharmacy owner account can manage all workspace access.",
        )
    email = str(payload.email).lower()
    if db.scalar(
        select(User.id).where(func.lower(User.email) == email)
    ):
        raise HTTPException(status_code=409, detail="That email is already assigned to a user.")
    new_user = User(
        store_id=user.store_id,
        name=payload.name,
        email=email,
        password_hash=hash_password(payload.password),
        role=role,
    )
    db.add(new_user)
    db.flush()
    record_audit(db, user, "user.created", "user", new_user.id, f"{email}; role {role.value}.")
    db.commit()
    db.refresh(new_user)
    return new_user


def get_customer(db: Session, store_id: UUID, customer_id: UUID) -> Customer:
    customer = db.scalar(
        select(Customer).where(
            Customer.id == customer_id,
            Customer.store_id == store_id,
            Customer.is_active.is_(True),
        )
    )
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found.")
    return customer


@router.get("/customers", response_model=list[CustomerRead])
def list_customers(
    search: str = Query(default="", max_length=120),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[CustomerRead]:
    query = select(Customer).where(
        Customer.store_id == user.store_id,
        Customer.is_active.is_(True),
    )
    if search.strip():
        term = f"%{search.strip()}%"
        query = query.where(
            Customer.name.ilike(term) | Customer.phone.ilike(term)
        )
    customers = db.scalars(query.order_by(Customer.name)).all()
    can_view_financials = user.role in ADMIN_ROLES
    return [
        CustomerRead.model_validate({
            **CustomerRead.model_validate(customer).model_dump(),
            "credit_limit": customer.credit_limit if can_view_financials else None,
            "opening_balance": customer.opening_balance if can_view_financials else None,
        })
        for customer in customers
    ]


@router.post(
    "/customers",
    response_model=CustomerRead,
    status_code=status.HTTP_201_CREATED,
)
def create_customer(
    payload: CustomerCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Customer:
    if (payload.credit_limit or payload.opening_balance) and user.role not in ADMIN_ROLES:
        raise HTTPException(
            status_code=403,
            detail="Only finance-authorized roles may assign credit limits or opening balances.",
        )
    phone = payload.phone.strip() or None
    if phone and db.scalar(
        select(Customer.id).where(
            Customer.store_id == user.store_id,
            Customer.phone == phone,
            Customer.is_active.is_(True),
        )
    ):
        raise HTTPException(status_code=409, detail="A customer with that phone already exists.")
    customer = Customer(
        store_id=user.store_id,
        **payload.model_dump(exclude={"phone", "email"}),
        phone=phone,
        email=str(payload.email) if payload.email else None,
    )
    db.add(customer)
    db.flush()
    if customer.opening_balance:
        db.add_all([
            LedgerEntry(
                store_id=user.store_id,
                customer_id=customer.id,
                account="accounts_receivable",
                entry_type="opening_balance",
                debit=customer.opening_balance,
                credit=Decimal("0"),
                reference=f"OPEN-{customer.id}",
                description="Customer opening balance",
                created_by=user.id,
            ),
            LedgerEntry(
                store_id=user.store_id,
                account="opening_balance_equity",
                entry_type="opening_balance",
                debit=Decimal("0"),
                credit=customer.opening_balance,
                reference=f"OPEN-{customer.id}",
                description="Offset for customer opening balance",
                created_by=user.id,
            ),
        ])
    record_audit(db, user, "customer.created", "customer", customer.id, customer.name)
    db.commit()
    db.refresh(customer)
    return customer


@router.get("/customers/{customer_id}/ledger")
def customer_ledger(
    customer_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> dict:
    customer = get_customer(db, user.store_id, customer_id)
    entries = list(
        db.scalars(
            select(LedgerEntry)
            .where(
                LedgerEntry.store_id == user.store_id,
                LedgerEntry.customer_id == customer.id,
            )
            .order_by(LedgerEntry.created_at, LedgerEntry.id)
        ).all()
    )
    balance = Decimal("0")
    statement = []
    today = date.today()
    aging = {"current": Decimal("0"), "30_days": Decimal("0"), "60_days": Decimal("0"), "90_days": Decimal("0")}
    for entry in entries:
        balance += entry.debit - entry.credit
        statement.append({
            "id": str(entry.id),
            "date": entry.created_at.isoformat(),
            "type": entry.entry_type,
            "account": entry.account,
            "description": entry.description,
            "reference": entry.reference,
            "debit": entry.debit,
            "credit": entry.credit,
            "balance": balance,
        })
        if entry.debit > entry.credit:
            age = max(0, (today - entry.created_at.date()).days)
            bucket = "90_days" if age >= 90 else "60_days" if age >= 60 else "30_days" if age >= 30 else "current"
            aging[bucket] += entry.debit - entry.credit
    return {
        "customer": CustomerRead.model_validate(customer),
        "balance": balance,
        "credit_limit": customer.credit_limit,
        "aging": aging,
        "entries": statement,
    }


@router.post("/customers/{customer_id}/payments", status_code=201)
def record_customer_payment(
    customer_id: UUID,
    payload: LedgerPayment,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> dict:
    customer = get_customer(db, user.store_id, customer_id)
    try:
        method = PaymentMethod(payload.method)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Unsupported payment method.") from error
    if method == PaymentMethod.CREDIT:
        raise HTTPException(status_code=422, detail="A customer payment cannot be paid on credit.")
    if payload.amount <= 0:
        raise HTTPException(status_code=422, detail="Payment amount must be greater than zero.")
    balance = db.scalar(
        select(func.coalesce(func.sum(LedgerEntry.debit - LedgerEntry.credit), 0)).where(
            LedgerEntry.store_id == user.store_id,
            LedgerEntry.customer_id == customer.id,
            LedgerEntry.account == "accounts_receivable",
        )
    ) or Decimal("0")
    if payload.amount > balance:
        raise HTTPException(
            status_code=409,
            detail=f"Payment exceeds the current balance ({balance}).",
        )
    reference = payload.reference.strip() or f"CP-{uuid4().hex[:10].upper()}"
    db.add_all([
        LedgerEntry(
            store_id=user.store_id,
            customer_id=customer.id,
            account="accounts_receivable",
            entry_type="payment",
            debit=Decimal("0"),
            credit=payload.amount,
            reference=reference,
            description=payload.description.strip() or f"Customer payment via {method.value}",
            created_by=user.id,
        ),
        LedgerEntry(
            store_id=user.store_id,
            customer_id=customer.id,
            account="cash" if method == PaymentMethod.CASH else "bank",
            entry_type="payment",
            debit=payload.amount,
            credit=Decimal("0"),
            reference=reference,
            description=payload.description.strip() or f"Customer payment via {method.value}",
            created_by=user.id,
        ),
    ])
    record_audit(db, user, "customer.payment", "customer", customer.id, f"{reference}; {payload.amount}.")
    db.commit()
    return {"reference": reference, "amount": payload.amount, "balance": balance - payload.amount}


@router.get("/suppliers", response_model=list[SupplierRead])
def list_suppliers(
    search: str = Query(default="", max_length=120),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SupplierRead]:
    query = select(Supplier).where(
        Supplier.store_id == user.store_id,
        Supplier.is_active.is_(True),
    )
    if search.strip():
        query = query.where(
            Supplier.name.ilike(f"%{search.strip()}%")
            | Supplier.phone.ilike(f"%{search.strip()}%")
        )
    suppliers = db.scalars(query.order_by(Supplier.name)).all()
    can_view_financials = user.role in ADMIN_ROLES
    return [
        SupplierRead.model_validate({
            **SupplierRead.model_validate(supplier).model_dump(),
            "opening_balance": supplier.opening_balance if can_view_financials else None,
        })
        for supplier in suppliers
    ]


@router.post(
    "/suppliers",
    response_model=SupplierRead,
    status_code=status.HTTP_201_CREATED,
)
def create_supplier(
    payload: SupplierCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*STOCK_ROLES)),
) -> Supplier:
    if payload.opening_balance and user.role not in ADMIN_ROLES:
        raise HTTPException(
            status_code=403,
            detail="Only finance-authorized roles may assign supplier opening balances.",
        )
    if db.scalar(
        select(Supplier.id).where(
            Supplier.store_id == user.store_id,
            func.lower(Supplier.name) == payload.name.lower(),
            Supplier.is_active.is_(True),
        )
    ):
        raise HTTPException(status_code=409, detail="That supplier already exists.")
    supplier = Supplier(
        store_id=user.store_id,
        **payload.model_dump(exclude={"email", "phone"}),
        email=str(payload.email) if payload.email else None,
        phone=payload.phone.strip() or None,
    )
    db.add(supplier)
    db.flush()
    if supplier.opening_balance:
        reference = f"OPEN-{supplier.id}"
        db.add_all([
            LedgerEntry(
                store_id=user.store_id,
                supplier_id=supplier.id,
                account="accounts_payable",
                entry_type="opening_balance",
                debit=Decimal("0"),
                credit=supplier.opening_balance,
                reference=reference,
                description="Supplier opening balance",
                created_by=user.id,
            ),
            LedgerEntry(
                store_id=user.store_id,
                account="opening_balance_equity",
                entry_type="opening_balance",
                debit=supplier.opening_balance,
                credit=Decimal("0"),
                reference=reference,
                description="Offset for supplier opening balance",
                created_by=user.id,
            ),
        ])
    record_audit(db, user, "supplier.created", "supplier", supplier.id, supplier.name)
    db.commit()
    db.refresh(supplier)
    return supplier


@router.get("/suppliers/{supplier_id}/ledger")
def supplier_ledger(
    supplier_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> dict:
    supplier = db.scalar(
        select(Supplier).where(
            Supplier.id == supplier_id,
            Supplier.store_id == user.store_id,
            Supplier.is_active.is_(True),
        )
    )
    if supplier is None:
        raise HTTPException(status_code=404, detail="Supplier not found.")
    entries = list(
        db.scalars(
            select(LedgerEntry)
            .where(
                LedgerEntry.store_id == user.store_id,
                LedgerEntry.supplier_id == supplier.id,
                LedgerEntry.account == "accounts_payable",
            )
            .order_by(LedgerEntry.created_at, LedgerEntry.id)
        ).all()
    )
    balance = Decimal("0")
    statement = []
    for entry in entries:
        balance += entry.credit - entry.debit
        statement.append({
            "id": str(entry.id),
            "date": entry.created_at.isoformat(),
            "type": entry.entry_type,
            "description": entry.description,
            "reference": entry.reference,
            "debit": entry.debit,
            "credit": entry.credit,
            "balance": balance,
        })
    return {
        "supplier": SupplierRead.model_validate(supplier),
        "balance": balance,
        "entries": statement,
    }


@router.post("/suppliers/{supplier_id}/payments", status_code=201)
def record_supplier_payment(
    supplier_id: UUID,
    payload: LedgerPayment,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> dict:
    supplier = db.scalar(
        select(Supplier).where(
            Supplier.id == supplier_id,
            Supplier.store_id == user.store_id,
            Supplier.is_active.is_(True),
        )
    )
    if supplier is None:
        raise HTTPException(status_code=404, detail="Supplier not found.")
    try:
        method = PaymentMethod(payload.method)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Unsupported payment method.") from error
    if method == PaymentMethod.CREDIT:
        raise HTTPException(status_code=422, detail="A supplier payment cannot be paid on credit.")
    if payload.amount <= 0:
        raise HTTPException(status_code=422, detail="Payment amount must be greater than zero.")
    outstanding = supplier.opening_balance + (
        db.scalar(
            select(func.coalesce(func.sum(LedgerEntry.credit - LedgerEntry.debit), 0)).where(
                LedgerEntry.store_id == user.store_id,
                LedgerEntry.supplier_id == supplier.id,
                LedgerEntry.account == "accounts_payable",
            )
        )
        or Decimal("0")
    )
    if payload.amount > outstanding:
        raise HTTPException(
            status_code=409,
            detail=f"Payment exceeds the current payable balance ({outstanding}).",
        )
    reference = payload.reference.strip() or f"SP-{uuid4().hex[:10].upper()}"
    db.add_all([
        LedgerEntry(
            store_id=user.store_id,
            supplier_id=supplier.id,
            account="accounts_payable",
            entry_type="payment",
            debit=payload.amount,
            credit=Decimal("0"),
            reference=reference,
            description=payload.description.strip() or f"Supplier payment via {method.value}",
            created_by=user.id,
        ),
        LedgerEntry(
            store_id=user.store_id,
            account="cash" if method == PaymentMethod.CASH else "bank",
            entry_type="payment",
            debit=Decimal("0"),
            credit=payload.amount,
            reference=reference,
            description=payload.description.strip() or f"Supplier payment via {method.value}",
            created_by=user.id,
        ),
    ])
    record_audit(db, user, "supplier.payment", "supplier", supplier.id, f"{reference}; {payload.amount}.")
    db.commit()
    return {"reference": reference, "amount": payload.amount, "balance": outstanding - payload.amount}


@router.get("/credit-balances")
def credit_balances(
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> dict:
    customers = db.scalars(
        select(Customer).where(Customer.store_id == user.store_id, Customer.is_active.is_(True))
    ).all()
    customer_rows = []
    for customer in customers:
        ledger = db.scalars(
            select(LedgerEntry)
            .where(
                LedgerEntry.store_id == user.store_id,
                LedgerEntry.customer_id == customer.id,
                LedgerEntry.account == "accounts_receivable",
            )
            .order_by(LedgerEntry.created_at, LedgerEntry.id)
        ).all()
        balance = sum((entry.debit - entry.credit for entry in ledger), Decimal("0"))
        if balance <= 0:
            continue
        credit_sales = db.execute(
            select(Sale, Payment)
            .join(Payment, Payment.sale_id == Sale.id)
            .where(
                Sale.store_id == user.store_id,
                Sale.customer_id == customer.id,
                Payment.method == PaymentMethod.CREDIT,
            )
            .order_by(Sale.created_at, Sale.id)
        ).all()
        remaining_repayments = max(
            Decimal("0"),
            sum((payment.amount for _, payment in credit_sales), Decimal("0")) - balance,
        )
        invoice_balances = []
        for sale, payment in credit_sales:
            applied = min(remaining_repayments, payment.amount)
            remaining_repayments -= applied
            due = payment.amount - applied
            if due <= 0:
                continue
            lines = db.execute(
                select(SaleLine.product_name, SaleLine.quantity)
                .where(SaleLine.sale_id == sale.id)
                .order_by(SaleLine.created_at, SaleLine.id)
            ).all()
            invoice_balances.append({
                "invoice_number": sale.invoice_number,
                "date": sale.created_at,
                "credit_amount": payment.amount,
                "outstanding": due,
                "items": [
                    {"name": name, "quantity": quantity} for name, quantity in lines
                ],
            })
        allocated = sum(
            (invoice["outstanding"] for invoice in invoice_balances),
            Decimal("0"),
        )
        customer_rows.append({
            "id": str(customer.id),
            "name": customer.name,
            "phone": customer.phone,
            "balance": balance,
            "credit_limit": customer.credit_limit,
            "unallocated_balance": max(Decimal("0"), balance - allocated),
            "credit_sales": invoice_balances,
        })

    suppliers = db.scalars(
        select(Supplier).where(Supplier.store_id == user.store_id, Supplier.is_active.is_(True))
    ).all()
    supplier_rows = []
    for supplier in suppliers:
        ledger = db.scalars(
            select(LedgerEntry)
            .where(
                LedgerEntry.store_id == user.store_id,
                LedgerEntry.supplier_id == supplier.id,
                LedgerEntry.account == "accounts_payable",
            )
            .order_by(LedgerEntry.created_at, LedgerEntry.id)
        ).all()
        balance = sum((entry.credit - entry.debit for entry in ledger), Decimal("0"))
        if balance <= 0:
            continue
        invoice_credits: dict[str, Decimal] = {}
        for entry in ledger:
            if entry.entry_type == "goods_received":
                invoice_credits[entry.reference] = (
                    invoice_credits.get(entry.reference, Decimal("0")) + entry.credit
                )
        purchases = db.scalars(
            select(Purchase)
            .where(
                Purchase.store_id == user.store_id,
                Purchase.supplier_id == supplier.id,
                Purchase.purchase_number.in_(invoice_credits or [""]),
            )
            .order_by(Purchase.created_at, Purchase.id)
        ).all()
        purchase_rows = []
        applied_payments = max(
            Decimal("0"),
            sum(invoice_credits.values(), Decimal("0"))
            - balance,
        )
        for purchase in purchases:
            amount = invoice_credits.get(purchase.purchase_number, Decimal("0"))
            applied = min(amount, applied_payments)
            applied_payments -= applied
            outstanding = amount - applied
            if outstanding > 0:
                received_items = db.execute(
                    select(PurchaseLine.product_id, PurchaseLine.quantity_received)
                    .where(
                        PurchaseLine.purchase_id == purchase.id,
                        PurchaseLine.quantity_received > 0,
                    )
                    .order_by(PurchaseLine.id)
                ).all()
                product_names = dict(
                    db.execute(
                        select(Product.id, Product.name).where(
                            Product.id.in_([product_id for product_id, _ in received_items])
                        )
                    ).all()
                )
                purchase_rows.append({
                    "purchase_number": purchase.purchase_number,
                    "date": purchase.created_at,
                    "received_amount": amount,
                    "outstanding": outstanding,
                    "status": purchase.status.value,
                    "items": [
                        {"name": product_names[product_id], "quantity": quantity}
                        for product_id, quantity in received_items
                    ],
                })
        allocated = sum(
            (purchase["outstanding"] for purchase in purchase_rows),
            Decimal("0"),
        )
        supplier_rows.append({
            "id": str(supplier.id),
            "name": supplier.name,
            "phone": supplier.phone,
            "balance": balance,
            "unallocated_balance": max(Decimal("0"), balance - allocated),
            "open_purchases": purchase_rows,
        })
    return {"customers": customer_rows, "suppliers": supplier_rows}


@router.post(
    "/sales",
    response_model=SaleDetail,
    status_code=status.HTTP_201_CREATED,
)
def create_sale(
    payload: SaleCreate,
    idempotency_key: str | None = Header(
        default=None,
        alias="Idempotency-Key",
        min_length=16,
        max_length=128,
    ),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SaleDetail:
    fingerprint = sale_fingerprint(payload, user) if idempotency_key else None
    if idempotency_key:
        previous_sale = db.scalar(
            select(Sale).where(
                Sale.store_id == user.store_id,
                Sale.idempotency_key == idempotency_key,
            )
        )
        if previous_sale:
            if previous_sale.idempotency_fingerprint != fingerprint:
                raise HTTPException(
                    status_code=409,
                    detail="This idempotency key was already used for a different sale.",
                )
            return build_sale_detail(db, previous_sale)

    payment_rows: list[tuple[PaymentInput, PaymentMethod]] = []
    for payment in payload.payments:
        try:
            method = PaymentMethod(payment.method)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=f"Unsupported payment method: {payment.method}.") from error
        payment_rows.append((payment, method))

    credit_amount = sum(
        (amount.amount for amount, method in payment_rows if method == PaymentMethod.CREDIT),
        Decimal("0"),
    )
    customer = None
    if payload.customer_id:
        customer = get_customer(db, user.store_id, payload.customer_id)
    if credit_amount > 0 and customer is None:
        raise HTTPException(status_code=422, detail="Select a registered customer for credit payments.")

    product_ids = {line.product_id for line in payload.lines}
    products = {
        product.id: product
        for product in db.scalars(
            select(Product)
            .where(
                Product.id.in_(product_ids),
                Product.store_id == user.store_id,
                Product.is_active.is_(True),
            )
        ).all()
    }
    if len(products) != len(product_ids):
        raise HTTPException(status_code=404, detail="One or more products were not found.")

    prepared_lines = []
    subtotal = Decimal("0")
    for line in payload.lines:
        product = products[line.product_id]
        gross = money(product.sale_price * line.quantity)
        if line.discount > gross:
            raise HTTPException(
                status_code=422,
                detail=f"Discount cannot exceed the line value for {product.name}.",
            )
        net = gross - line.discount
        subtotal += gross
        prepared_lines.append({
            "product": product,
            "quantity": line.quantity,
            "gross": gross,
            "line_discount": line.discount,
            "net_before_invoice_discount": net,
        })

    subtotal = money(subtotal)
    line_discounts = sum((line["line_discount"] for line in prepared_lines), Decimal("0"))
    if payload.invoice_discount > subtotal - line_discounts:
        raise HTTPException(status_code=422, detail="Invoice discount exceeds the remaining subtotal.")
    discount = money(line_discounts + payload.invoice_discount)

    invoice_number = f"INV-{datetime.now(timezone.utc):%Y%m%d}-{uuid4().hex[:8].upper()}"
    sale = Sale(
        store_id=user.store_id,
        customer_id=customer.id if customer else None,
        invoice_number=invoice_number,
        idempotency_key=idempotency_key,
        idempotency_fingerprint=fingerprint,
        cashier_id=user.id,
        prescription_reference=payload.prescription_reference.strip(),
        subtotal=subtotal,
        discount=discount,
        tax_total=Decimal("0"),
        total=Decimal("0"),
        cost_total=Decimal("0"),
    )
    db.add(sale)
    db.flush()

    total_cost = Decimal("0")
    tax_total = Decimal("0")
    sale_lines: list[SaleLine] = []
    for line in prepared_lines:
        product: Product = line["product"]
        remaining = line["quantity"]
        batches = list(
            db.scalars(
                select(Batch)
                .where(
                    Batch.store_id == user.store_id,
                    Batch.product_id == product.id,
                    Batch.quantity > 0,
                    Batch.expiry_date >= date.today(),
                )
                .order_by(Batch.expiry_date, Batch.received_at, Batch.id)
                .with_for_update()
            ).all()
        )
        available = sum((batch.quantity for batch in batches), Decimal("0"))
        if available < remaining:
            raise HTTPException(
                status_code=409,
                detail=f"Not enough unexpired stock for {product.name}; {available} packs available.",
            )

        allocated_cost = Decimal("0")
        for batch in batches:
            if remaining <= 0:
                break
            picked = min(batch.quantity, remaining)
            previous = batch.quantity
            batch.quantity -= picked
            remaining -= picked
            allocated_cost += picked * batch.purchase_price
            db.add(
                StockMovement(
                    store_id=user.store_id,
                    batch_id=batch.id,
                    product_id=product.id,
                    user_id=user.id,
                    movement_type=MovementType.SALE,
                    quantity_change=-picked,
                    previous_quantity=previous,
                    new_quantity=batch.quantity,
                    reason="Point-of-sale checkout (FEFO)",
                    reference=invoice_number,
                )
            )
        net_before_invoice = line["net_before_invoice_discount"]
        invoice_share = (
            money(payload.invoice_discount * net_before_invoice / (subtotal - line_discounts))
            if payload.invoice_discount and subtotal > line_discounts
            else Decimal("0")
        )
        taxable_amount = max(Decimal("0"), net_before_invoice - invoice_share)
        line_tax = money(taxable_amount * product.tax_rate / Decimal("100"))
        tax_total += line_tax
        total_cost += allocated_cost
        sale_lines.append(
            SaleLine(
                sale_id=sale.id,
                product_id=product.id,
                product_name=product.name,
                quantity=line["quantity"],
                unit_price=product.sale_price,
                discount=money(line["line_discount"] + invoice_share),
                tax_rate=product.tax_rate,
                cost_total=money(allocated_cost),
            )
        )

    sale.tax_total = money(tax_total)
    sale.cost_total = money(total_cost)
    sale.total = money(subtotal - discount + sale.tax_total)
    if sum((payment.amount for payment, _ in payment_rows), Decimal("0")) != sale.total:
        raise HTTPException(
            status_code=422,
            detail=f"Split payments must equal the invoice total of {sale.total}.",
        )

    if credit_amount:
        customer = db.scalar(
            select(Customer)
            .where(
                Customer.id == customer.id,
                Customer.store_id == user.store_id,
                Customer.is_active.is_(True),
            )
            .with_for_update()
        )
        if customer is None:
            raise HTTPException(status_code=404, detail="Customer not found.")
        current_balance = db.scalar(
            select(
                func.coalesce(func.sum(LedgerEntry.debit - LedgerEntry.credit), 0)
            ).where(
                LedgerEntry.store_id == user.store_id,
                LedgerEntry.customer_id == customer.id,
                LedgerEntry.account == "accounts_receivable",
            )
        ) or Decimal("0")
        if current_balance + credit_amount > customer.credit_limit:
            raise HTTPException(
                status_code=409,
                detail="The customer's credit limit would be exceeded.",
            )

    db.add_all(sale_lines)
    db.add_all([
        Payment(
            store_id=user.store_id,
            sale_id=sale.id,
            method=method,
            amount=payment.amount,
            reference=payment.reference.strip(),
        )
        for payment, method in payment_rows
    ])
    for payment, method in payment_rows:
        if method != PaymentMethod.CREDIT:
            db.add(
                LedgerEntry(
                    store_id=user.store_id,
                    account=method.value,
                    entry_type="sale_payment",
                    debit=payment.amount,
                    credit=Decimal("0"),
                    reference=invoice_number,
                    description=f"{method.value} receipt for {invoice_number}",
                    created_by=user.id,
                )
            )
    if credit_amount:
        db.add(
            LedgerEntry(
                store_id=user.store_id,
                customer_id=customer.id,
                account="accounts_receivable",
                entry_type="sale",
                debit=credit_amount,
                credit=Decimal("0"),
                reference=invoice_number,
                description=f"Credit portion of invoice {invoice_number}",
                created_by=user.id,
            )
        )
    revenue = sale.total - sale.tax_total
    if revenue:
        db.add(
            LedgerEntry(
                store_id=user.store_id,
                account="sales_revenue",
                entry_type="sale",
                debit=Decimal("0"),
                credit=revenue,
                reference=invoice_number,
                description=f"Revenue for invoice {invoice_number}",
                created_by=user.id,
            )
        )
    if sale.tax_total:
        db.add(
            LedgerEntry(
                store_id=user.store_id,
                account="tax_payable",
                entry_type="sale_tax",
                debit=Decimal("0"),
                credit=sale.tax_total,
                reference=invoice_number,
                description=f"Tax on invoice {invoice_number}",
                created_by=user.id,
            )
        )
    if sale.cost_total:
        db.add_all([
            LedgerEntry(
                store_id=user.store_id,
                account="cost_of_goods_sold",
                entry_type="sale_cogs",
                debit=sale.cost_total,
                credit=Decimal("0"),
                reference=invoice_number,
                description=f"Cost of goods sold for {invoice_number}",
                created_by=user.id,
            ),
            LedgerEntry(
                store_id=user.store_id,
                account="inventory",
                entry_type="sale_cogs",
                debit=Decimal("0"),
                credit=sale.cost_total,
                reference=invoice_number,
                description=f"Inventory issued for {invoice_number}",
                created_by=user.id,
            ),
        ])
    record_audit(
        db,
        user,
        "sale.completed",
        "sale",
        sale.id,
        f"Invoice {invoice_number}; total {sale.total}.",
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if not idempotency_key:
            raise
        previous_sale = db.scalar(
            select(Sale).where(
                Sale.store_id == user.store_id,
                Sale.idempotency_key == idempotency_key,
            )
        )
        if previous_sale is None:
            raise
        if previous_sale.idempotency_fingerprint != fingerprint:
            raise HTTPException(
                status_code=409,
                detail="This idempotency key was already used for a different sale.",
            )
        return build_sale_detail(db, previous_sale)
    db.refresh(sale)
    return build_sale_detail(db, sale)


@router.get("/sales", response_model=list[SaleRead])
def list_sales(
    start_date: date | None = None,
    end_date: date | None = None,
    cashier_id: UUID | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> list[Sale]:
    query = select(Sale).where(Sale.store_id == user.store_id)
    if start_date:
        query = query.where(Sale.created_at >= datetime.combine(start_date, time.min, timezone.utc))
    if end_date:
        query = query.where(Sale.created_at < datetime.combine(end_date + timedelta(days=1), time.min, timezone.utc))
    if cashier_id:
        query = query.where(Sale.cashier_id == cashier_id)
    return list(db.scalars(query.order_by(Sale.created_at.desc()).limit(500)).all())


@router.get("/sales/{sale_id}", response_model=SaleDetail)
def sale_detail(
    sale_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> SaleDetail:
    sale = db.scalar(
        select(Sale).where(Sale.id == sale_id, Sale.store_id == user.store_id)
    )
    if sale is None:
        raise HTTPException(status_code=404, detail="Invoice not found.")
    lines = list(db.scalars(select(SaleLine).where(SaleLine.sale_id == sale.id)).all())
    return SaleDetail(
        **SaleRead.model_validate(sale).model_dump(),
        lines=[SaleLineRead.model_validate(line) for line in lines],
    )


@router.post("/purchases", response_model=PurchaseRead, status_code=201)
def create_purchase(
    payload: PurchaseCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> Purchase:
    supplier = db.scalar(
        select(Supplier).where(
            Supplier.id == payload.supplier_id,
            Supplier.store_id == user.store_id,
            Supplier.is_active.is_(True),
        )
    )
    if supplier is None:
        raise HTTPException(status_code=404, detail="Supplier not found.")
    product_ids = {line.product_id for line in payload.lines}
    products = list(
        db.scalars(
            select(Product).where(
                Product.id.in_(product_ids),
                Product.store_id == user.store_id,
                Product.is_active.is_(True),
            )
        ).all()
    )
    if len(products) != len(product_ids):
        raise HTTPException(status_code=404, detail="One or more products were not found.")
    product_by_id = {product.id: product for product in products}
    subtotal = Decimal("0")
    tax_total = Decimal("0")
    for line in payload.lines:
        product = product_by_id[line.product_id]
        if line.expiry_date < date.today():
            raise HTTPException(status_code=422, detail="Purchase order batch expiry must be in the future.")
        line_subtotal = money(line.quantity_ordered * line.unit_cost)
        subtotal += line_subtotal
        tax_total += money(line_subtotal * product.tax_rate / Decimal("100"))
    number = f"PO-{datetime.now(timezone.utc):%Y%m%d}-{uuid4().hex[:8].upper()}"
    purchase = Purchase(
        store_id=user.store_id,
        supplier_id=supplier.id,
        purchase_number=number,
        supplier_invoice=payload.supplier_invoice.strip(),
        status=PurchaseStatus.ORDERED,
        subtotal=money(subtotal),
        tax_total=money(tax_total),
        total=money(subtotal + tax_total),
        paid=Decimal("0"),
        due_date=payload.due_date,
        notes=payload.notes.strip(),
        created_by=user.id,
    )
    db.add(purchase)
    db.flush()
    db.add_all([
        PurchaseLine(
            purchase_id=purchase.id,
            product_id=line.product_id,
            batch_number=line.batch_number,
            expiry_date=line.expiry_date,
            quantity_ordered=line.quantity_ordered,
            quantity_received=Decimal("0"),
            unit_cost=line.unit_cost,
            tax_rate=product_by_id[line.product_id].tax_rate,
        )
        for line in payload.lines
    ])
    record_audit(db, user, "purchase.created", "purchase", purchase.id, number)
    db.commit()
    db.refresh(purchase)
    return purchase


@router.get("/purchases", response_model=list[PurchaseRead])
def list_purchases(
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> list[Purchase]:
    return list(
        db.scalars(
            select(Purchase)
            .where(Purchase.store_id == user.store_id)
            .order_by(Purchase.created_at.desc())
            .limit(500)
        ).all()
    )


@router.get("/purchases/{purchase_id}/lines")
def purchase_lines(
    purchase_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> list[dict]:
    purchase = db.scalar(
        select(Purchase.id).where(
            Purchase.id == purchase_id,
            Purchase.store_id == user.store_id,
        )
    )
    if purchase is None:
        raise HTTPException(status_code=404, detail="Purchase order not found.")
    rows = db.execute(
        select(PurchaseLine, Product.name)
        .join(Product, Product.id == PurchaseLine.product_id)
        .where(PurchaseLine.purchase_id == purchase_id)
        .order_by(PurchaseLine.id)
    ).all()
    return [
        {
            "id": str(line.id),
            "product_id": str(line.product_id),
            "product_name": product_name,
            "batch_number": line.batch_number,
            "expiry_date": line.expiry_date,
            "quantity_ordered": line.quantity_ordered,
            "quantity_received": line.quantity_received,
            "unit_cost": line.unit_cost,
            "tax_rate": line.tax_rate,
        }
        for line, product_name in rows
    ]


@router.post("/purchases/{purchase_id}/receive", response_model=PurchaseRead)
def receive_purchase_line(
    purchase_id: UUID,
    payload: PurchaseReceive,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> Purchase:
    purchase = db.scalar(
        select(Purchase)
        .where(Purchase.id == purchase_id, Purchase.store_id == user.store_id)
        .with_for_update()
    )
    if purchase is None:
        raise HTTPException(status_code=404, detail="Purchase order not found.")
    line = db.scalar(
        select(PurchaseLine)
        .where(PurchaseLine.id == payload.line_id, PurchaseLine.purchase_id == purchase.id)
        .with_for_update()
    )
    if line is None:
        raise HTTPException(status_code=404, detail="Purchase order line not found.")
    if line.expiry_date < date.today():
        raise HTTPException(status_code=409, detail="Expired items cannot be received.")
    remaining = line.quantity_ordered - line.quantity_received
    if payload.quantity > remaining:
        raise HTTPException(
            status_code=409,
            detail=f"Received quantity exceeds open order quantity ({remaining}).",
        )
    batch = db.scalar(
        select(Batch).where(
            Batch.store_id == user.store_id,
            Batch.product_id == line.product_id,
            Batch.batch_number == line.batch_number,
            Batch.expiry_date == line.expiry_date,
        )
    )
    previous = batch.quantity if batch else Decimal("0")
    if batch:
        batch.quantity += payload.quantity
        batch.purchase_price = line.unit_cost
    else:
        batch = Batch(
            store_id=user.store_id,
            product_id=line.product_id,
            supplier_id=purchase.supplier_id,
            batch_number=line.batch_number,
            expiry_date=line.expiry_date,
            quantity=payload.quantity,
            purchase_price=line.unit_cost,
        )
        db.add(batch)
        db.flush()
    previously_received = line.quantity_received
    line.quantity_received += payload.quantity
    lines = list(
        db.scalars(select(PurchaseLine).where(PurchaseLine.purchase_id == purchase.id)).all()
    )
    purchase.status = (
        PurchaseStatus.RECEIVED
        if all(item.quantity_received >= item.quantity_ordered for item in lines)
        else PurchaseStatus.PARTIALLY_RECEIVED
    )
    db.add(
        StockMovement(
            store_id=user.store_id,
            batch_id=batch.id,
            product_id=line.product_id,
            user_id=user.id,
            movement_type=MovementType.RECEIPT,
            quantity_change=payload.quantity,
            previous_quantity=previous,
            new_quantity=batch.quantity,
            reason="Goods received against purchase order",
            reference=purchase.purchase_number,
        )
    )
    received_cost = money(payload.quantity * line.unit_cost)
    tax_before = money(
        money(previously_received * line.unit_cost) * line.tax_rate / Decimal("100")
    )
    tax_after = money(
        money(line.quantity_received * line.unit_cost) * line.tax_rate / Decimal("100")
    )
    received_tax = tax_after - tax_before
    payable_amount = received_cost + received_tax
    if received_cost:
        db.add(
            LedgerEntry(
                store_id=user.store_id,
                supplier_id=purchase.supplier_id,
                account="inventory",
                entry_type="goods_received",
                debit=received_cost,
                credit=Decimal("0"),
                reference=purchase.purchase_number,
                description=f"Inventory received for {purchase.purchase_number}",
                created_by=user.id,
            )
        )
    if received_tax:
        db.add(
            LedgerEntry(
                store_id=user.store_id,
                supplier_id=purchase.supplier_id,
                account="input_tax",
                entry_type="goods_received_tax",
                debit=received_tax,
                credit=Decimal("0"),
                reference=purchase.purchase_number,
                description=f"Input tax for {purchase.purchase_number}",
                created_by=user.id,
            )
        )
    if payable_amount:
        db.add(
            LedgerEntry(
                store_id=user.store_id,
                supplier_id=purchase.supplier_id,
                account="accounts_payable",
                entry_type="goods_received",
                debit=Decimal("0"),
                credit=payable_amount,
                reference=purchase.purchase_number,
                description=f"Supplier payable for {purchase.purchase_number}",
                created_by=user.id,
            )
        )
    record_audit(
        db,
        user,
        "purchase.received",
        "purchase",
        purchase.id,
        f"Received {payload.quantity} for {line.batch_number}.",
    )
    db.commit()
    db.refresh(purchase)
    return purchase


@router.post("/expenses", status_code=201)
def create_expense(
    payload: ExpenseCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> dict:
    try:
        method = PaymentMethod(payload.payment_method)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Unsupported expense payment method.") from error
    expense = Expense(
        store_id=user.store_id,
        created_by=user.id,
        category=payload.category,
        description=payload.description,
        amount=payload.amount,
        payment_method=method,
    )
    db.add(expense)
    db.flush()
    db.add_all([
        LedgerEntry(
            store_id=user.store_id,
            account=f"expense:{expense.category.lower().replace(' ', '_')}",
            entry_type="expense",
            debit=expense.amount,
            credit=Decimal("0"),
            reference=str(expense.id),
            description=expense.description,
            created_by=user.id,
        ),
        LedgerEntry(
            store_id=user.store_id,
            account="cash" if method == PaymentMethod.CASH else "bank",
            entry_type="expense",
            debit=Decimal("0"),
            credit=expense.amount,
            reference=str(expense.id),
            description=expense.description,
            created_by=user.id,
        ),
    ])
    record_audit(db, user, "expense.created", "expense", expense.id, expense.description)
    db.commit()
    db.refresh(expense)
    return {
        "id": str(expense.id),
        "category": expense.category,
        "description": expense.description,
        "amount": expense.amount,
        "payment_method": expense.payment_method.value,
        "created_at": expense.created_at,
    }


@router.get("/expenses")
def list_expenses(
    start_date: date | None = None,
    end_date: date | None = None,
    timezone_name: str = "UTC",
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> list[dict]:
    if start_date and end_date and start_date > end_date:
        raise HTTPException(status_code=422, detail="Start date must not be after end date.")
    zone = get_store_timezone(timezone_name)
    query = select(Expense).where(Expense.store_id == user.store_id)
    if start_date:
        start_at, _ = local_date_bounds(start_date, start_date, zone)
        query = query.where(Expense.created_at >= start_at)
    if end_date:
        _, end_at = local_date_bounds(end_date, end_date, zone)
        query = query.where(Expense.created_at < end_at)
    expenses = db.scalars(query.order_by(Expense.created_at.desc()).limit(1000)).all()
    return [
        {
            "id": str(item.id),
            "category": item.category,
            "description": item.description,
            "amount": item.amount,
            "payment_method": item.payment_method.value,
            "created_at": item.created_at,
        }
        for item in expenses
    ]


@router.post("/ledger/journals", status_code=201)
def create_journal_entry(
    payload: JournalEntryCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> dict:
    debit_total = money(sum((line.debit for line in payload.lines), Decimal("0")))
    credit_total = money(sum((line.credit for line in payload.lines), Decimal("0")))
    if debit_total <= 0 or debit_total != credit_total:
        raise HTTPException(status_code=422, detail="Journal debits and credits must balance.")
    if any(line.debit and line.credit for line in payload.lines):
        raise HTTPException(
            status_code=422,
            detail="Each journal line must contain either a debit or a credit, not both.",
        )
    reference = payload.reference.strip() or f"JE-{uuid4().hex[:10].upper()}"
    entries = [
        LedgerEntry(
            store_id=user.store_id,
            account=line.account.strip(),
            entry_type="journal",
            debit=line.debit,
            credit=line.credit,
            reference=reference,
            description=payload.description,
            created_by=user.id,
        )
        for line in payload.lines
    ]
    db.add_all(entries)
    record_audit(db, user, "ledger.journal_created", "journal", reference, payload.description)
    db.commit()
    return {
        "reference": reference,
        "description": payload.description,
        "debit_total": debit_total,
        "credit_total": credit_total,
        "lines": len(entries),
    }


@router.get("/ledger")
def general_ledger(
    account: str | None = Query(default=None, max_length=120),
    start_date: date | None = None,
    end_date: date | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> dict:
    query = select(LedgerEntry).where(LedgerEntry.store_id == user.store_id)
    if account:
        query = query.where(LedgerEntry.account == account)
    if start_date:
        query = query.where(
            LedgerEntry.created_at >= datetime.combine(start_date, time.min, timezone.utc)
        )
    if end_date:
        query = query.where(
            LedgerEntry.created_at < datetime.combine(
                end_date + timedelta(days=1), time.min, timezone.utc
            )
        )
    entries = list(db.scalars(query.order_by(LedgerEntry.created_at, LedgerEntry.id)).all())
    balances: dict[str, Decimal] = {}
    rows = []
    for entry in entries:
        balance = balances.get(entry.account, Decimal("0")) + entry.debit - entry.credit
        balances[entry.account] = balance
        rows.append({
            "id": str(entry.id),
            "date": entry.created_at,
            "account": entry.account,
            "type": entry.entry_type,
            "reference": entry.reference,
            "description": entry.description,
            "debit": entry.debit,
            "credit": entry.credit,
            "balance": balance,
        })
    return {"entries": rows, "account_balances": balances}


@router.get("/cash/shifts")
def list_shifts(
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> list[dict]:
    shifts = db.scalars(
        select(CashShift)
        .where(CashShift.store_id == user.store_id)
        .order_by(CashShift.opened_at.desc())
        .limit(50)
    ).all()
    return [
        {
            "id": str(item.id),
            "user_id": str(item.user_id),
            "opening_cash": item.opening_cash,
            "expected_closing_cash": item.expected_closing_cash,
            "actual_closing_cash": item.actual_closing_cash,
            "variance": item.variance,
            "opened_at": item.opened_at,
            "closed_at": item.closed_at,
            "notes": item.notes,
        }
        for item in shifts
    ]


@router.post("/cash/shifts/open", status_code=201)
def open_shift(
    payload: ShiftOpen,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    active = db.scalar(
        select(CashShift.id).where(
            CashShift.store_id == user.store_id,
            CashShift.user_id == user.id,
            CashShift.closed_at.is_(None),
        )
    )
    if active:
        raise HTTPException(status_code=409, detail="You already have an open cash shift.")
    shift = CashShift(
        store_id=user.store_id,
        user_id=user.id,
        opening_cash=payload.opening_cash,
        notes=payload.notes.strip(),
    )
    db.add(shift)
    db.flush()
    record_audit(db, user, "cash_shift.opened", "cash_shift", shift.id, "Register opened.")
    db.commit()
    return {"id": str(shift.id), "opening_cash": shift.opening_cash, "opened_at": shift.opened_at}


@router.post("/cash/shifts/{shift_id}/close")
def close_shift(
    shift_id: UUID,
    payload: ShiftClose,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    shift = db.scalar(
        select(CashShift)
        .where(
            CashShift.id == shift_id,
            CashShift.store_id == user.store_id,
            CashShift.user_id == user.id,
            CashShift.closed_at.is_(None),
        )
        .with_for_update()
    )
    if shift is None:
        raise HTTPException(status_code=404, detail="Open cash shift not found.")
    opening = shift.opened_at
    if opening.tzinfo is None:
        opening = opening.replace(tzinfo=timezone.utc)
    cash_sales = db.scalar(
        select(func.coalesce(func.sum(Payment.amount), 0))
        .join(Sale, Sale.id == Payment.sale_id)
        .where(
            Payment.store_id == user.store_id,
            Payment.method == PaymentMethod.CASH,
            Sale.cashier_id == user.id,
            Payment.created_at >= opening,
        )
    ) or Decimal("0")
    cash_expenses = db.scalar(
        select(func.coalesce(func.sum(Expense.amount), 0)).where(
            Expense.store_id == user.store_id,
            Expense.created_by == user.id,
            Expense.payment_method == PaymentMethod.CASH,
            Expense.created_at >= opening,
        )
    ) or Decimal("0")
    expected = shift.opening_cash + cash_sales - cash_expenses
    shift.expected_closing_cash = expected
    shift.actual_closing_cash = payload.actual_closing_cash
    shift.variance = payload.actual_closing_cash - expected
    shift.closed_at = datetime.now(timezone.utc)
    shift.notes = payload.notes.strip()
    record_audit(
        db,
        user,
        "cash_shift.closed",
        "cash_shift",
        shift.id,
        f"Expected {expected}; counted {payload.actual_closing_cash}; variance {shift.variance}.",
    )
    db.commit()
    return {
        "id": str(shift.id),
        "expected_closing_cash": shift.expected_closing_cash,
        "actual_closing_cash": shift.actual_closing_cash,
        "variance": shift.variance,
        "closed_at": shift.closed_at,
    }


@router.get("/store")
def get_store(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    store = db.get(Store, user.store_id)
    return {
        "id": str(store.id),
        "name": store.name,
        "address": store.address,
        "phone": store.phone,
        "tax_number": store.tax_number,
        "currency": store.currency,
        "tax_rate": store.tax_rate,
        "expiry_alert_days": store.expiry_alert_days,
        "invoice_prefix": store.invoice_prefix,
        "tenant_status": store.tenant_status.value,
        "plan_code": store.plan_code,
        "trial_ends_at": store.trial_ends_at,
    }


@router.patch("/store")
def update_store(
    payload: StoreUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(UserRole.OWNER)),
) -> dict:
    store = db.get(Store, user.store_id)
    for field, value in payload.model_dump().items():
        setattr(store, field, value.strip().upper() if field in {"currency", "invoice_prefix"} else value)
    record_audit(db, user, "store.updated", "store", store.id, "Store settings changed.")
    db.commit()
    return get_store(db, user)


@router.get("/audit")
def list_audit_logs(
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> list[dict]:
    logs = db.scalars(
        select(AuditLog)
        .where(AuditLog.store_id == user.store_id)
        .order_by(AuditLog.created_at.desc())
        .limit(limit)
    ).all()
    return [
        {
            "id": str(item.id),
            "user_id": str(item.user_id),
            "action": item.action,
            "entity_type": item.entity_type,
            "entity_id": item.entity_id,
            "details": item.details,
            "created_at": item.created_at,
        }
        for item in logs
    ]


@router.get("/reports/sales")
def sales_report(
    start_date: date | None = None,
    end_date: date | None = None,
    timezone_name: str = "UTC",
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*ADMIN_ROLES)),
) -> dict:
    if start_date and end_date and start_date > end_date:
        raise HTTPException(status_code=422, detail="Start date must not be after end date.")
    zone = get_store_timezone(timezone_name)
    query = select(Sale).where(Sale.store_id == user.store_id)
    if start_date:
        start_at, _ = local_date_bounds(start_date, start_date, zone)
        query = query.where(Sale.created_at >= start_at)
    if end_date:
        _, end_at = local_date_bounds(end_date, end_date, zone)
        query = query.where(Sale.created_at < end_at)
    sales = list(db.scalars(query.order_by(Sale.created_at)).all())
    grouped: dict[str, dict] = {}
    for sale in sales:
        key = local_date(sale.created_at, zone).isoformat()
        day = grouped.setdefault(key, {"date": key, "transactions": 0, "revenue": Decimal("0"), "profit": Decimal("0")})
        day["transactions"] += 1
        day["revenue"] += sale.total
        day["profit"] += sale.total - sale.tax_total - sale.cost_total
    return {
        "transactions": len(sales),
        "revenue": sum((sale.total for sale in sales), Decimal("0")),
        "profit": sum(
            (sale.total - sale.tax_total - sale.cost_total for sale in sales),
            Decimal("0"),
        ),
        "daily": list(grouped.values()),
    }
