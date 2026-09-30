from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_platform_operator
from app.models import (
    Batch,
    LedgerEntry,
    PlatformAuditLog,
    PlatformOperator,
    PlatformSubscriptionInvoice,
    Product,
    Sale,
    Store,
    SubscriptionInvoiceStatus,
    TenantStatus,
    User,
    UserRole,
)
from app.schemas import (
    LoginRequest,
    PlatformInvoiceCreate,
    PlatformInvoiceReview,
    PlatformPasswordChange,
    PlatformTenantCreate,
    TenantStatusUpdate,
)
from app.security import create_access_token, hash_password, verify_password
from app.timeutils import get_store_timezone, local_date_bounds

router = APIRouter(prefix="/api/platform", tags=["SaaS platform"])


@router.post("/auth/login")
def platform_login(
    payload: LoginRequest,
    db: Session = Depends(get_db),
) -> dict:
    if not settings.bootstrap_platform_email:
        raise HTTPException(status_code=503, detail="Platform operator access is not configured.")
    operator = db.scalar(
        select(PlatformOperator).where(
            func.lower(PlatformOperator.email) == str(payload.email).lower()
        )
    )
    if (
        str(payload.email).lower() != str(settings.bootstrap_platform_email).lower()
        or operator is None
        or not operator.is_active
        or not verify_password(payload.password, operator.password_hash)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Email or password is incorrect.",
        )
    db.commit()
    return {
        "access_token": create_access_token(
            operator.id,
            token_type="platform",
            auth_version=operator.auth_version,
        ),
        "token_type": "bearer",
        "operator": {"id": str(operator.id), "name": operator.name, "email": operator.email},
    }


@router.get("/auth/me")
def platform_me(
    operator: PlatformOperator = Depends(get_current_platform_operator),
) -> dict:
    return {"id": str(operator.id), "name": operator.name, "email": operator.email}


@router.post("/auth/password", status_code=status.HTTP_204_NO_CONTENT)
def change_platform_password(
    payload: PlatformPasswordChange,
    db: Session = Depends(get_db),
    operator: PlatformOperator = Depends(get_current_platform_operator),
) -> None:
    if not verify_password(payload.current_password, operator.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect.",
        )
    operator.password_hash = hash_password(payload.new_password)
    operator.auth_version += 1
    db.add(
        PlatformAuditLog(
            operator_id=operator.id,
            action="platform.password_changed",
            details="Platform operator password changed; all existing sessions revoked.",
        )
    )
    db.commit()


@router.get("/tenants")
def list_tenants(
    timezone_name: str = "UTC",
    db: Session = Depends(get_db),
    operator: PlatformOperator = Depends(get_current_platform_operator),
) -> list[dict]:
    rows = db.execute(
        select(Store, func.count(User.id))
        .outerjoin(User, User.store_id == Store.id)
        .group_by(Store.id)
        .order_by(Store.created_at.desc())
    ).all()
    zone = get_store_timezone(timezone_name)
    today = datetime.now(timezone.utc).astimezone(zone).date()
    today_start, today_end = local_date_bounds(today, today, zone)
    sales_by_store = {
        store_id: {"sales": sales, "transactions": transactions}
        for store_id, sales, transactions in db.execute(
            select(Sale.store_id, func.sum(Sale.total), func.count(Sale.id))
            .where(Sale.created_at >= today_start, Sale.created_at < today_end)
            .group_by(Sale.store_id)
        ).all()
    }
    ledger_by_store: dict[UUID, dict[str, Decimal]] = {}
    for store_id, account, debit, credit in db.execute(
        select(
            LedgerEntry.store_id,
            LedgerEntry.account,
            func.sum(LedgerEntry.debit),
            func.sum(LedgerEntry.credit),
        )
        .where(LedgerEntry.account.in_(("accounts_receivable", "accounts_payable")))
        .group_by(LedgerEntry.store_id, LedgerEntry.account)
    ).all():
        ledger_by_store.setdefault(store_id, {})[account] = debit - credit

    stock = (
        select(
            Product.store_id.label("store_id"),
            Product.id.label("product_id"),
            Product.reorder_level.label("reorder_level"),
            func.coalesce(func.sum(Batch.quantity), 0).label("quantity"),
        )
        .outerjoin(
            Batch,
            and_(Batch.product_id == Product.id, Batch.store_id == Product.store_id),
        )
        .where(Product.is_active.is_(True))
        .group_by(Product.store_id, Product.id, Product.reorder_level)
        .subquery()
    )
    stock_by_store = {
        store_id: {"medicine_count": count, "low_stock": low_stock}
        for store_id, count, low_stock in db.execute(
            select(
                stock.c.store_id,
                func.count(stock.c.product_id),
                func.sum(case((stock.c.quantity <= stock.c.reorder_level, 1), else_=0)),
            ).group_by(stock.c.store_id)
        ).all()
    }
    store_by_id = {store.id: store for store, _ in rows}
    expiry_by_store = {store.id: {"near": 0, "expired": 0} for store, _ in rows}
    for store_id, expiry_date, quantity in db.execute(
        select(Batch.store_id, Batch.expiry_date, Batch.quantity).where(Batch.quantity > 0)
    ).all():
        store = store_by_id.get(store_id)
        if store is None or expiry_date > today + timedelta(days=store.expiry_alert_days):
            continue
        expiry_by_store.setdefault(store_id, {"near": 0, "expired": 0})
        expiry_by_store[store_id]["expired" if expiry_date < today else "near"] += 1
    return [
        {
            "id": str(store.id),
            "name": store.name,
            "status": store.tenant_status.value,
            "plan_code": store.plan_code,
            "currency": store.currency,
            "trial_ends_at": store.trial_ends_at,
            "subscription_expires_at": store.subscription_expires_at,
            "user_count": user_count,
            "created_at": store.created_at,
            "today_sales": sales_by_store.get(store.id, {}).get("sales", Decimal("0")),
            "today_transactions": sales_by_store.get(store.id, {}).get("transactions", 0),
            "medicine_count": stock_by_store.get(store.id, {}).get("medicine_count", 0),
            "low_stock_products": stock_by_store.get(store.id, {}).get("low_stock", 0),
            "expiring_batches": expiry_by_store.get(store.id, {}).get("near", 0),
            "expired_batches": expiry_by_store.get(store.id, {}).get("expired", 0),
            "receivables": ledger_by_store.get(store.id, {}).get("accounts_receivable", Decimal("0")),
            "payables": -ledger_by_store.get(store.id, {}).get("accounts_payable", Decimal("0")),
        }
        for store, user_count in rows
    ]


@router.post("/tenants", status_code=status.HTTP_201_CREATED)
def provision_tenant(
    payload: PlatformTenantCreate,
    db: Session = Depends(get_db),
    operator: PlatformOperator = Depends(get_current_platform_operator),
) -> dict:
    admin_email = str(payload.administrator_email).lower()
    if db.scalar(select(User.id).where(func.lower(User.email) == admin_email)):
        raise HTTPException(status_code=409, detail="That email is already assigned to a user.")
    now = datetime.now(timezone.utc)
    tenant_status = TenantStatus.TRIAL if payload.trial_days else TenantStatus.ACTIVE
    store = Store(
        name=payload.pharmacy_name.strip(),
        tenant_status=tenant_status,
        plan_code=payload.plan_code,
        trial_ends_at=now + timedelta(days=payload.trial_days) if payload.trial_days else None,
    )
    db.add(store)
    db.flush()
    administrator = User(
        store_id=store.id,
        name=payload.administrator_name.strip(),
        email=admin_email,
        password_hash=hash_password(payload.administrator_password),
        role=UserRole.OWNER,
    )
    db.add(administrator)
    db.add(
        PlatformAuditLog(
            operator_id=operator.id,
            store_id=store.id,
            action="tenant.provisioned",
            details=f"Provisioned {store.name}; plan {store.plan_code}; status {store.tenant_status.value}.",
        )
    )
    db.commit()
    db.refresh(store)
    return {
        "pharmacy": {
            "id": str(store.id),
            "name": store.name,
            "status": store.tenant_status.value,
            "plan_code": store.plan_code,
            "trial_ends_at": store.trial_ends_at,
        },
        "administrator": {
            "id": str(administrator.id),
            "name": administrator.name,
            "email": administrator.email,
            "role": administrator.role.value,
        },
    }


@router.patch("/tenants/{store_id}")
def update_tenant(
    store_id: UUID,
    payload: TenantStatusUpdate,
    db: Session = Depends(get_db),
    operator: PlatformOperator = Depends(get_current_platform_operator),
) -> dict:
    try:
        tenant_status = TenantStatus(payload.status)
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail="Status must be trial, active, suspended, or cancelled.",
        ) from error
    store = db.get(Store, store_id)
    if store is None:
        raise HTTPException(status_code=404, detail="Pharmacy account not found.")
    if tenant_status == TenantStatus.TRIAL and store.trial_ends_at is None:
        if payload.trial_days is None:
            raise HTTPException(
                status_code=422,
                detail="Provide trial_days when setting an account to trial status.",
            )
    previous_status = store.tenant_status.value
    previous_plan = store.plan_code
    store.tenant_status = tenant_status
    store.plan_code = payload.plan_code
    if tenant_status == TenantStatus.TRIAL and payload.trial_days is not None:
        store.trial_ends_at = datetime.now(timezone.utc) + timedelta(days=payload.trial_days)
    db.add(
        PlatformAuditLog(
            operator_id=operator.id,
            store_id=store.id,
            action="tenant.updated",
            details=(
                f"Status {previous_status} -> {tenant_status.value}; "
                f"plan {previous_plan} -> {store.plan_code}."
            ),
        )
    )
    db.commit()
    return {"id": str(store.id), "name": store.name, "status": store.tenant_status.value, "plan_code": store.plan_code}


def invoice_response(invoice: PlatformSubscriptionInvoice) -> dict:
    return {
        "id": str(invoice.id),
        "store_id": str(invoice.store_id),
        "invoice_number": invoice.invoice_number,
        "plan_code": invoice.plan_code,
        "amount": invoice.amount,
        "currency": invoice.currency,
        "period_start": invoice.period_start,
        "period_end": invoice.period_end,
        "due_at": invoice.due_at,
        "status": invoice.status.value,
        "payment_method": invoice.payment_method,
        "payment_reference": invoice.payment_reference,
        "paid_amount": invoice.paid_amount,
        "submitted_at": invoice.submitted_at,
        "reviewed_at": invoice.reviewed_at,
        "review_note": invoice.review_note,
    }


@router.get("/tenants/{store_id}/invoices")
def list_subscription_invoices(
    store_id: UUID,
    db: Session = Depends(get_db),
    operator: PlatformOperator = Depends(get_current_platform_operator),
) -> list[dict]:
    if db.get(Store, store_id) is None:
        raise HTTPException(status_code=404, detail="Pharmacy account not found.")
    invoices = db.scalars(
        select(PlatformSubscriptionInvoice)
        .where(PlatformSubscriptionInvoice.store_id == store_id)
        .order_by(PlatformSubscriptionInvoice.created_at.desc())
    ).all()
    return [invoice_response(invoice) for invoice in invoices]


@router.post("/tenants/{store_id}/invoices", status_code=status.HTTP_201_CREATED)
def create_subscription_invoice(
    store_id: UUID,
    payload: PlatformInvoiceCreate,
    db: Session = Depends(get_db),
    operator: PlatformOperator = Depends(get_current_platform_operator),
) -> dict:
    store = db.get(Store, store_id)
    if store is None:
        raise HTTPException(status_code=404, detail="Pharmacy account not found.")
    now = datetime.now(timezone.utc)
    period_start = now
    for existing_end in (store.trial_ends_at, store.subscription_expires_at):
        if existing_end is None:
            continue
        if existing_end.tzinfo is None:
            existing_end = existing_end.replace(tzinfo=timezone.utc)
        period_start = max(period_start, existing_end)
    invoice = PlatformSubscriptionInvoice(
        store_id=store.id,
        invoice_number=f"MFL-{now:%Y%m%d}-{uuid4().hex[:8].upper()}",
        plan_code=payload.plan_code,
        amount=payload.amount,
        currency=store.currency,
        period_start=period_start,
        period_end=period_start + timedelta(days=payload.duration_days),
        due_at=now + timedelta(days=payload.due_days),
        status=SubscriptionInvoiceStatus.DUE,
    )
    db.add(invoice)
    db.add(
        PlatformAuditLog(
            operator_id=operator.id,
            store_id=store.id,
            action="subscription.invoice_created",
            details=(
                f"{invoice.invoice_number}; {invoice.amount} {invoice.currency}; "
                f"{invoice.plan_code} for {payload.duration_days} days."
            ),
        )
    )
    db.commit()
    db.refresh(invoice)
    return invoice_response(invoice)


@router.patch("/invoices/{invoice_id}/review")
def review_subscription_invoice(
    invoice_id: UUID,
    payload: PlatformInvoiceReview,
    db: Session = Depends(get_db),
    operator: PlatformOperator = Depends(get_current_platform_operator),
) -> dict:
    invoice = db.get(PlatformSubscriptionInvoice, invoice_id)
    if invoice is None:
        raise HTTPException(status_code=404, detail="Subscription invoice not found.")
    if invoice.status == SubscriptionInvoiceStatus.PAID:
        raise HTTPException(status_code=409, detail="A paid invoice cannot be changed.")
    if payload.status == SubscriptionInvoiceStatus.PAID.value:
        if invoice.status != SubscriptionInvoiceStatus.SUBMITTED:
            raise HTTPException(status_code=409, detail="Only a submitted payment can be approved.")
        if invoice.paid_amount != invoice.amount:
            raise HTTPException(
                status_code=409,
                detail="The submitted payment amount does not match the invoice total.",
            )
        store = db.get(Store, invoice.store_id)
        if store is None:
            raise HTTPException(status_code=404, detail="Pharmacy account not found.")
        store.plan_code = invoice.plan_code
        store.tenant_status = TenantStatus.ACTIVE
        current_expiry = store.subscription_expires_at
        if current_expiry is not None and current_expiry.tzinfo is None:
            current_expiry = current_expiry.replace(tzinfo=timezone.utc)
        period_end = invoice.period_end
        if period_end.tzinfo is None:
            period_end = period_end.replace(tzinfo=timezone.utc)
        store.subscription_expires_at = max(current_expiry or period_end, period_end)
        invoice.status = SubscriptionInvoiceStatus.PAID
    elif payload.status == SubscriptionInvoiceStatus.REJECTED.value:
        if invoice.status != SubscriptionInvoiceStatus.SUBMITTED:
            raise HTTPException(status_code=409, detail="Only a submitted payment can be rejected.")
        invoice.status = SubscriptionInvoiceStatus.REJECTED
    else:
        if invoice.status == SubscriptionInvoiceStatus.SUBMITTED:
            raise HTTPException(status_code=409, detail="Review or reject the submitted payment first.")
        invoice.status = SubscriptionInvoiceStatus.VOID
    invoice.reviewed_by_id = operator.id
    invoice.reviewed_at = datetime.now(timezone.utc)
    invoice.review_note = payload.note.strip()
    db.add(
        PlatformAuditLog(
            operator_id=operator.id,
            store_id=invoice.store_id,
            action=f"subscription.invoice_{invoice.status.value}",
            details=f"{invoice.invoice_number}; {invoice.review_note or 'No review note.'}",
        )
    )
    db.commit()
    db.refresh(invoice)
    return invoice_response(invoice)


@router.get("/audit")
def platform_audit(
    db: Session = Depends(get_db),
    operator: PlatformOperator = Depends(get_current_platform_operator),
) -> list[dict]:
    rows = db.execute(
        select(PlatformAuditLog, PlatformOperator.name, Store.name)
        .join(PlatformOperator, PlatformOperator.id == PlatformAuditLog.operator_id)
        .outerjoin(Store, Store.id == PlatformAuditLog.store_id)
        .order_by(PlatformAuditLog.created_at.desc())
        .limit(500)
    ).all()
    return [
        {
            "action": log.action,
            "details": log.details,
            "operator": operator_name,
            "pharmacy": store_name,
            "created_at": log.created_at,
        }
        for log, operator_name, store_name in rows
    ]
