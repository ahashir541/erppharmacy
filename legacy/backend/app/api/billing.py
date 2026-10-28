from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.platform import invoice_response
from app.audit import record_audit
from app.config import settings
from app.database import get_db
from app.dependencies import get_authenticated_user
from app.models import (
    PlatformSubscriptionInvoice,
    Store,
    SubscriptionInvoiceStatus,
    TenantStatus,
    User,
    UserRole,
)
from app.schemas import PlatformInvoicePaymentSubmit

router = APIRouter(prefix="/api/billing", tags=["subscription billing"])


def configured_payment_instructions() -> list[dict[str, str]]:
    methods = []
    if settings.billing_jazzcash_account_name and settings.billing_jazzcash_account_number:
        methods.append({
            "method": "jazzcash",
            "label": "JazzCash wallet transfer",
            "account_name": settings.billing_jazzcash_account_name,
            "account_number": settings.billing_jazzcash_account_number,
        })
    if settings.billing_easypaisa_account_name and settings.billing_easypaisa_account_number:
        methods.append({
            "method": "easypaisa",
            "label": "Easypaisa wallet transfer",
            "account_name": settings.billing_easypaisa_account_name,
            "account_number": settings.billing_easypaisa_account_number,
        })
    if settings.billing_bank_name and (
        settings.billing_bank_account_number or settings.billing_bank_iban
    ):
        methods.append({
            "method": "bank_transfer",
            "label": "Bank transfer",
            "bank_name": settings.billing_bank_name,
            "account_title": settings.billing_bank_account_title,
            "account_number": settings.billing_bank_account_number,
            "iban": settings.billing_bank_iban,
        })
    methods.append({
        "method": "manual",
        "label": "Other manual payment",
        "instructions": "Contact MedFlow support for alternate payment instructions.",
    })
    return methods


@router.get("/status")
def billing_status(
    db: Session = Depends(get_db),
    user: User = Depends(get_authenticated_user),
) -> dict:
    store = db.get(Store, user.store_id)
    if store is None:
        raise HTTPException(status_code=403, detail="This pharmacy account is unavailable.")
    now = datetime.now(timezone.utc)
    trial_end = store.trial_ends_at
    expiry = store.subscription_expires_at
    if trial_end is not None and trial_end.tzinfo is None:
        trial_end = trial_end.replace(tzinfo=timezone.utc)
    if expiry is not None and expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    trial_valid = store.tenant_status == TenantStatus.TRIAL and trial_end is not None and trial_end > now
    paid_valid = store.tenant_status == TenantStatus.ACTIVE and (expiry is None or expiry > now)
    return {
        "pharmacy_name": store.name,
        "status": store.tenant_status.value,
        "plan_code": store.plan_code,
        "trial_ends_at": trial_end,
        "subscription_expires_at": expiry,
        "restricted": not (trial_valid or paid_valid),
    }


@router.get("/payment-instructions")
def payment_instructions(
    user: User = Depends(get_authenticated_user),
) -> list[dict[str, str]]:
    return configured_payment_instructions()


@router.get("/invoices")
def list_invoices(
    db: Session = Depends(get_db),
    user: User = Depends(get_authenticated_user),
) -> list[dict]:
    invoices = db.scalars(
        select(PlatformSubscriptionInvoice)
        .where(PlatformSubscriptionInvoice.store_id == user.store_id)
        .order_by(PlatformSubscriptionInvoice.created_at.desc())
    ).all()
    return [invoice_response(invoice) for invoice in invoices]


@router.post("/invoices/{invoice_id}/payment")
def submit_invoice_payment(
    invoice_id: UUID,
    payload: PlatformInvoicePaymentSubmit,
    db: Session = Depends(get_db),
    user: User = Depends(get_authenticated_user),
) -> dict:
    if user.role != UserRole.OWNER:
        raise HTTPException(status_code=403, detail="Only a pharmacy administrator can submit subscription payments.")
    invoice = db.scalar(
        select(PlatformSubscriptionInvoice).where(
            PlatformSubscriptionInvoice.id == invoice_id,
            PlatformSubscriptionInvoice.store_id == user.store_id,
        )
    )
    if invoice is None:
        raise HTTPException(status_code=404, detail="Subscription invoice not found.")
    if invoice.status not in {
        SubscriptionInvoiceStatus.DUE,
        SubscriptionInvoiceStatus.REJECTED,
    }:
        raise HTTPException(status_code=409, detail="This invoice is not accepting a payment submission.")
    available_methods = {
        method["method"] for method in configured_payment_instructions()
    }
    if payload.method not in available_methods:
        raise HTTPException(status_code=422, detail="This payment method is not configured.")
    if payload.paid_amount != invoice.amount:
        raise HTTPException(
            status_code=422,
            detail=f"Submit the full invoice amount of {invoice.amount} {invoice.currency}.",
        )
    invoice.status = SubscriptionInvoiceStatus.SUBMITTED
    invoice.payment_method = payload.method
    invoice.payment_reference = payload.reference
    invoice.paid_amount = payload.paid_amount
    invoice.submitted_at = datetime.now(timezone.utc)
    invoice.reviewed_by_id = None
    invoice.reviewed_at = None
    invoice.review_note = ""
    record_audit(
        db,
        user,
        "subscription.payment_submitted",
        "subscription_invoice",
        invoice.id,
        f"{invoice.invoice_number}; {payload.method}; {payload.reference}.",
    )
    db.commit()
    db.refresh(invoice)
    return invoice_response(invoice)
