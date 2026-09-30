from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.inventory import product_stock_query
from app.database import get_db
from app.dependencies import get_current_user, require_roles
from app.models import (
    Batch,
    Expense,
    LedgerEntry,
    Payment,
    Product,
    Sale,
    SaleLine,
    Store,
    User,
    UserRole,
)
from app.timeutils import get_store_timezone, local_date, local_date_bounds

router = APIRouter(prefix="/api", tags=["dashboard and reports"])
FINANCIAL_ROLES = (UserRole.OWNER, UserRole.ADMIN, UserRole.ACCOUNTANT)


@router.get("/dashboard")
def dashboard(
    period: str = "weekly",
    timezone_name: str = "UTC",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    if period not in {"weekly", "monthly", "yearly"}:
        raise HTTPException(status_code=422, detail="Period must be weekly, monthly, or yearly.")
    zone = get_store_timezone(timezone_name)
    now = datetime.now(timezone.utc)
    today = now.astimezone(zone).date()
    today_start, today_end = local_date_bounds(today, today, zone)
    trend_first_day = today - timedelta(days=29)
    trend_start, _ = local_date_bounds(trend_first_day, trend_first_day, zone)
    if period == "weekly":
        period_start = today - timedelta(days=today.weekday())
        period_end = period_start + timedelta(days=7)
        bucket_starts = [period_start + timedelta(days=offset) for offset in range(7)]
    elif period == "monthly":
        period_start = today.replace(day=1)
        period_end = (period_start + timedelta(days=32)).replace(day=1)
        bucket_starts = [
            period_start + timedelta(days=offset)
            for offset in range((period_end - period_start).days)
        ]
    else:
        period_start = today.replace(month=1, day=1)
        period_end = date(period_start.year + 1, 1, 1)
        bucket_starts = [date(period_start.year, month, 1) for month in range(1, 13)]
    period_start_dt, period_end_dt = local_date_bounds(
        period_start, period_end - timedelta(days=1), zone
    )
    sales_today = list(
        db.scalars(
            select(Sale).where(
                Sale.store_id == user.store_id,
                Sale.created_at >= today_start,
                Sale.created_at < today_end,
            )
        ).all()
    )
    inventory_value = db.scalar(
        select(func.coalesce(func.sum(Batch.quantity * Batch.purchase_price), 0)).where(
            Batch.store_id == user.store_id
        )
    ) or Decimal("0")
    stock, _ = product_stock_query(user.store_id)
    low_stock = db.execute(
        select(Product.id)
        .where(Product.store_id == user.store_id, Product.is_active.is_(True), stock <= Product.reorder_level)
    ).all()
    store = db.get(Store, user.store_id)
    expiry_days = store.expiry_alert_days
    expiry_query = select(Batch.expiry_date).where(
        Batch.store_id == user.store_id,
        Batch.quantity > 0,
        Batch.expiry_date <= date.today() + timedelta(days=expiry_days),
    )
    expiring_batches = list(db.scalars(expiry_query).all())
    expired_batches = [expiry for expiry in expiring_batches if expiry < date.today()]
    recent_sales = list(
        db.scalars(
            select(Sale)
            .where(Sale.store_id == user.store_id)
            .order_by(Sale.created_at.desc())
            .limit(8)
        ).all()
    )
    trend_sales = list(
        db.scalars(
            select(Sale).where(
                Sale.store_id == user.store_id,
                Sale.created_at >= trend_start,
                Sale.created_at < now,
            )
        ).all()
    )
    daily: dict[str, dict] = {}
    for sale in trend_sales:
        key = local_date(sale.created_at, zone).isoformat()
        point = daily.setdefault(
            key,
            {"date": key, "sales": Decimal("0"), "profit": Decimal("0")},
        )
        point["sales"] += sale.total
        point["profit"] += sale.total - sale.tax_total - sale.cost_total
    trend = [
        daily.get(
            (trend_first_day + timedelta(days=offset)).isoformat(),
            {
                "date": (trend_first_day + timedelta(days=offset)).isoformat(),
                "sales": Decimal("0"),
                "profit": Decimal("0"),
            },
        )
        for offset in range(30)
    ]
    period_sales = list(db.scalars(
        select(Sale).where(
            Sale.store_id == user.store_id,
            Sale.created_at >= period_start_dt,
            Sale.created_at < period_end_dt,
        )
    ).all())
    period_expenses = list(db.scalars(
        select(Expense).where(
            Expense.store_id == user.store_id,
            Expense.created_at >= period_start_dt,
            Expense.created_at < period_end_dt,
        )
    ).all()) if user.role in FINANCIAL_ROLES else []
    sales_by_bucket: dict[str, dict] = {}
    expenses_by_bucket: dict[str, Decimal] = {}
    for sale in period_sales:
        sale_date = local_date(sale.created_at, zone)
        bucket = (
            sale_date.replace(day=1).isoformat()
            if period == "yearly"
            else sale_date.isoformat()
        )
        point = sales_by_bucket.setdefault(
            bucket,
            {"sales": Decimal("0"), "profit": Decimal("0"), "transactions": 0},
        )
        point["sales"] += sale.total
        point["profit"] += sale.total - sale.tax_total - sale.cost_total
        point["transactions"] += 1
    for expense in period_expenses:
        expense_date = local_date(expense.created_at, zone)
        bucket = (
            expense_date.replace(day=1).isoformat()
            if period == "yearly"
            else expense_date.isoformat()
        )
        expenses_by_bucket[bucket] = expenses_by_bucket.get(bucket, Decimal("0")) + expense.amount
    management_trend = [
        {
            "date": bucket.isoformat(),
            "sales": sales_by_bucket.get(bucket.isoformat(), {}).get("sales", Decimal("0")),
            "profit": sales_by_bucket.get(bucket.isoformat(), {}).get("profit", Decimal("0")),
            "expenses": expenses_by_bucket.get(bucket.isoformat(), Decimal("0")),
            "transactions": sales_by_bucket.get(bucket.isoformat(), {}).get("transactions", 0),
        }
        for bucket in bucket_starts
    ]

    product_rows = db.execute(
        select(
            SaleLine.product_id,
            SaleLine.product_name,
            func.sum(SaleLine.quantity).label("quantity"),
            func.sum(SaleLine.quantity * SaleLine.unit_price - SaleLine.discount).label("revenue"),
        )
        .join(Sale, Sale.id == SaleLine.sale_id)
        .where(
            Sale.store_id == user.store_id,
            Sale.created_at >= period_start_dt,
            Sale.created_at < period_end_dt,
        )
        .group_by(SaleLine.product_id, SaleLine.product_name)
        .order_by(func.sum(SaleLine.quantity).desc())
        .limit(6)
    ).all()
    categories = db.execute(
        select(
            Product.category,
            func.sum(SaleLine.quantity * SaleLine.unit_price - SaleLine.discount).label("revenue"),
        )
        .join(SaleLine, SaleLine.product_id == Product.id)
        .join(Sale, Sale.id == SaleLine.sale_id)
        .where(
            Sale.store_id == user.store_id,
            Sale.created_at >= period_start_dt,
            Sale.created_at < period_end_dt,
        )
        .group_by(Product.category)
        .order_by(func.sum(SaleLine.quantity * SaleLine.unit_price - SaleLine.discount).desc())
        .limit(6)
    ).all()
    payment_rows = db.execute(
        select(Payment.method, func.sum(Payment.amount))
        .where(
            Payment.store_id == user.store_id,
            Payment.sale_id.is_not(None),
            Payment.created_at >= today_start,
            Payment.created_at < today_end,
        )
        .group_by(Payment.method)
    ).all()

    can_view_financials = user.role in FINANCIAL_ROLES
    receivables = None
    payables = None
    cash_balance = None
    bank_balance = None
    if can_view_financials:
        receivables = db.scalar(
            select(func.coalesce(func.sum(LedgerEntry.debit - LedgerEntry.credit), 0)).where(
                LedgerEntry.store_id == user.store_id,
                LedgerEntry.account == "accounts_receivable",
            )
        ) or Decimal("0")
        recorded_payables = db.scalar(
            select(func.coalesce(func.sum(LedgerEntry.credit - LedgerEntry.debit), 0)).where(
                LedgerEntry.store_id == user.store_id,
                LedgerEntry.account == "accounts_payable",
            )
        ) or Decimal("0")
        payables = recorded_payables
        account_balances = dict(
            db.execute(
                select(
                    LedgerEntry.account,
                    func.coalesce(func.sum(LedgerEntry.debit - LedgerEntry.credit), 0),
                )
                .where(
                    LedgerEntry.store_id == user.store_id,
                    LedgerEntry.account.in_(("cash", "bank")),
                )
                .group_by(LedgerEntry.account)
            ).all()
        )
        cash_balance = account_balances.get("cash", Decimal("0"))
        bank_balance = account_balances.get("bank", Decimal("0"))

    return {
        "as_of": now,
        "management": {
            "period": period,
            "start_date": period_start,
            "end_date": period_end - timedelta(days=1),
            "sales": sum((sale.total for sale in period_sales), Decimal("0"))
            if can_view_financials else None,
            "gross_profit": sum(
                (sale.total - sale.tax_total - sale.cost_total for sale in period_sales),
                Decimal("0"),
            ) if can_view_financials else None,
            "expenses": sum((expense.amount for expense in period_expenses), Decimal("0"))
            if can_view_financials else None,
            "net_after_expenses": (
                sum(
                    (sale.total - sale.tax_total - sale.cost_total for sale in period_sales),
                    Decimal("0"),
                )
                - sum((expense.amount for expense in period_expenses), Decimal("0"))
            ) if can_view_financials else None,
            "transactions": len(period_sales),
            "trend": management_trend if can_view_financials else [
                {
                    "date": point["date"],
                    "sales": None,
                    "profit": None,
                    "expenses": None,
                    "transactions": point["transactions"],
                }
                for point in management_trend
            ],
        },
        "today": {
            "sales": sum((sale.total for sale in sales_today), Decimal("0"))
            if can_view_financials
            else None,
            "profit": (
                sum(
                    (sale.total - sale.tax_total - sale.cost_total for sale in sales_today),
                    Decimal("0"),
                )
                if can_view_financials
                else None
            ),
            "transactions": len(sales_today),
        },
        "inventory": {
            "value": inventory_value if can_view_financials else None,
            "low_stock_products": len(low_stock),
            "expiring_batches": len(expiring_batches) - len(expired_batches),
            "expired_batches": len(expired_batches),
        },
        "receivables": receivables,
        "payables": payables,
        "cash_balance": cash_balance,
        "bank_balance": bank_balance,
        "trend": (
            trend
            if can_view_financials
            else [{"date": point["date"], "sales": point["sales"]} for point in trend]
        ),
        "top_products": [
            {
                "product_id": str(row.product_id),
                "name": row.product_name,
                "quantity": row.quantity,
                "revenue": row.revenue if can_view_financials else None,
            }
            for row in product_rows
        ],
        "top_categories": (
            [
                {"category": row.category or "Uncategorized", "revenue": row.revenue}
                for row in categories
            ]
            if can_view_financials
            else []
        ),
        "payment_breakdown": [
            {
                "method": method.value,
                "amount": amount,
            }
            for method, amount in payment_rows
        ] if can_view_financials else [],
        "recent_transactions": [
            {
                "id": str(sale.id),
                "invoice_number": sale.invoice_number,
                "created_at": sale.created_at,
                "total": sale.total if can_view_financials else None,
                "status": sale.status,
            }
            for sale in recent_sales
        ],
    }


@router.get("/reports/inventory")
def inventory_report(
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*FINANCIAL_ROLES)),
) -> dict:
    rows = db.execute(
        select(
            Product.id,
            Product.sku,
            Product.name,
            Product.category,
            Product.reorder_level,
            func.coalesce(func.sum(Batch.quantity), 0).label("quantity"),
            func.coalesce(func.sum(Batch.quantity * Batch.purchase_price), 0).label("value"),
        )
        .outerjoin(Batch, Batch.product_id == Product.id)
        .where(Product.store_id == user.store_id, Product.is_active.is_(True))
        .group_by(Product.id)
        .order_by(Product.name)
    ).all()
    return {
        "products": [
            {
                "id": str(row.id),
                "sku": row.sku,
                "name": row.name,
                "category": row.category,
                "quantity": row.quantity,
                "reorder_level": row.reorder_level,
                "inventory_value": row.value,
                "low_stock": row.quantity <= row.reorder_level,
            }
            for row in rows
        ],
        "total_value": sum((row.value for row in rows), Decimal("0")),
    }
