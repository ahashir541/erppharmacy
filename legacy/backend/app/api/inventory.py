from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.database import get_db
from app.dependencies import get_current_user, require_roles
from app.models import (
    Batch,
    LedgerEntry,
    MovementType,
    Product,
    StockMovement,
    Supplier,
    User,
    UserRole,
)
from app.schemas import (
    BatchRead,
    BatchReceipt,
    ProductCreate,
    ProductRead,
    ProductUpdate,
    StockAdjustment,
    StockMovementRead,
)

router = APIRouter(prefix="/api", tags=["inventory"])
STOCK_ROLES = (UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.PHARMACIST)
EXPIRY_REASONS = {
    "damage",
    "expiry write-off",
    "manual stock correction",
    "supplier return",
    "other",
}


def product_stock_query(store_id: UUID):
    stock = (
        select(func.coalesce(func.sum(Batch.quantity), 0))
        .where(Batch.product_id == Product.id, Batch.store_id == store_id)
        .correlate(Product)
        .scalar_subquery()
    )
    value = (
        select(
            func.coalesce(
                func.sum(Batch.quantity * Batch.purchase_price),
                Decimal("0"),
            )
        )
        .where(Batch.product_id == Product.id, Batch.store_id == store_id)
        .correlate(Product)
        .scalar_subquery()
    )
    return stock, value


def product_payload(db: Session, product: Product, show_cost: bool = True) -> ProductRead:
    stock, value = product_stock_query(product.store_id)
    totals = db.execute(
        select(stock, value).where(Product.id == product.id)
    ).one()
    return ProductRead.model_validate({
        **{
            column: getattr(product, column)
            for column in ProductRead.model_fields
            if hasattr(product, column)
        },
        "stock": totals[0],
        "inventory_value": totals[1],
        **({} if show_cost else {"purchase_price": None, "inventory_value": None}),
    })


def owned_product(db: Session, store_id: UUID, product_id: UUID) -> Product:
    product = db.scalar(
        select(Product).where(
            Product.id == product_id,
            Product.store_id == store_id,
            Product.is_active.is_(True),
        )
    )
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found.")
    return product


@router.get("/products", response_model=list[ProductRead])
def list_products(
    search: str = Query(default="", max_length=120),
    include_inactive: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ProductRead]:
    stock, value = product_stock_query(user.store_id)
    query = (
        select(Product, stock, value)
        .where(Product.store_id == user.store_id)
        .order_by(Product.name)
    )
    if not include_inactive:
        query = query.where(Product.is_active.is_(True))
    if search.strip():
        term = f"%{search.strip()}%"
        query = query.where(
            or_(
                Product.name.ilike(term),
                Product.generic_name.ilike(term),
                Product.sku.ilike(term),
                Product.barcode.ilike(term),
            )
        )
    rows = db.execute(query).all()
    return [
        ProductRead.model_validate({
            **{
                column: getattr(product, column)
                for column in ProductRead.model_fields
                if hasattr(product, column)
            },
            "stock": quantity,
            "inventory_value": inventory_value if user.role not in {
                UserRole.CASHIER, UserRole.PHARMACIST, UserRole.MANAGER
            } else None,
            "purchase_price": product.purchase_price if user.role not in {
                UserRole.CASHIER, UserRole.PHARMACIST, UserRole.MANAGER
            } else None,
        })
        for product, quantity, inventory_value in rows
    ]


@router.post(
    "/products",
    response_model=ProductRead,
    status_code=status.HTTP_201_CREATED,
)
def create_product(
    payload: ProductCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*STOCK_ROLES)),
) -> ProductRead:
    existing_sku = db.scalar(
        select(Product.id).where(
            Product.store_id == user.store_id,
            func.lower(Product.sku) == payload.sku.lower(),
        )
    )
    if existing_sku:
        raise HTTPException(status_code=409, detail="That product SKU already exists.")
    barcode = payload.barcode.strip() if payload.barcode else None
    if barcode and db.scalar(
        select(Product.id).where(
            Product.store_id == user.store_id,
            Product.barcode == barcode,
        )
    ):
        raise HTTPException(status_code=409, detail="That barcode is already assigned.")
    product = Product(
        store_id=user.store_id,
        **payload.model_dump(exclude={"barcode"}),
        barcode=barcode,
    )
    db.add(product)
    db.flush()
    record_audit(db, user, "product.created", "product", product.id, product.sku)
    db.commit()
    db.refresh(product)
    return product_payload(
        db,
        product,
        show_cost=user.role not in {UserRole.CASHIER, UserRole.PHARMACIST, UserRole.MANAGER},
    )


@router.patch("/products/{product_id}", response_model=ProductRead)
def update_product(
    product_id: UUID,
    payload: ProductUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*STOCK_ROLES)),
) -> ProductRead:
    product = owned_product(db, user.store_id, product_id)
    barcode = payload.barcode.strip() if payload.barcode else None
    duplicate = db.scalar(
        select(Product.id).where(
            Product.store_id == user.store_id,
            Product.id != product.id,
            Product.barcode == barcode,
        )
    ) if barcode else None
    if duplicate:
        raise HTTPException(status_code=409, detail="That barcode is already assigned.")
    previous_price = product.sale_price
    for field, value in payload.model_dump().items():
        setattr(product, field, value)
    product.barcode = barcode
    record_audit(
        db,
        user,
        "product.updated",
        "product",
        product.id,
        (
            f"Sale price changed from {previous_price} to {product.sale_price}."
            if previous_price != product.sale_price
            else f"Product details updated for {product.sku}."
        ),
    )
    db.commit()
    db.refresh(product)
    return product_payload(
        db,
        product,
        show_cost=user.role not in {UserRole.CASHIER, UserRole.PHARMACIST, UserRole.MANAGER},
    )


@router.delete("/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_product(
    product_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*STOCK_ROLES)),
) -> None:
    product = owned_product(db, user.store_id, product_id)
    on_hand = db.scalar(
        select(func.coalesce(func.sum(Batch.quantity), 0)).where(
            Batch.store_id == user.store_id,
            Batch.product_id == product_id,
        )
    ) or Decimal("0")
    if on_hand > 0:
        raise HTTPException(
            status_code=409,
            detail="Write off or transfer remaining stock before archiving this product.",
        )
    product.is_active = False
    record_audit(db, user, "product.archived", "product", product.id, product.sku)
    db.commit()


@router.get("/batches", response_model=list[BatchRead])
def list_batches(
    product_id: UUID | None = None,
    include_empty: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[BatchRead]:
    query = (
        select(Batch)
        .join(Product, Product.id == Batch.product_id)
        .where(Batch.store_id == user.store_id, Product.store_id == user.store_id)
        .order_by(Batch.expiry_date, Batch.created_at)
    )
    if product_id:
        query = query.where(Batch.product_id == product_id)
    if not include_empty:
        query = query.where(Batch.quantity > 0)
    batches = db.scalars(query).all()
    can_view_costs = user.role not in {
        UserRole.CASHIER,
        UserRole.PHARMACIST,
        UserRole.MANAGER,
    }
    return [
        BatchRead.model_validate({
            **{
                field: getattr(batch, field)
                for field in BatchRead.model_fields
                if hasattr(batch, field)
            },
            "purchase_price": batch.purchase_price if can_view_costs else None,
        })
        for batch in batches
    ]


@router.post(
    "/batches/receive",
    response_model=BatchRead,
    status_code=status.HTTP_201_CREATED,
)
def receive_batch(
    payload: BatchReceipt,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*STOCK_ROLES)),
) -> Batch:
    if payload.expiry_date < date.today():
        raise HTTPException(status_code=422, detail="Expired batches cannot be received.")
    product = owned_product(db, user.store_id, payload.product_id)
    if payload.supplier_id:
        supplier = db.scalar(
            select(Supplier).where(
                Supplier.id == payload.supplier_id,
                Supplier.store_id == user.store_id,
                Supplier.is_active.is_(True),
            )
        )
        if supplier is None:
            raise HTTPException(status_code=404, detail="Supplier not found.")
    existing = db.scalar(
        select(Batch).where(
            Batch.store_id == user.store_id,
            Batch.product_id == product.id,
            Batch.batch_number == payload.batch_number,
            Batch.expiry_date == payload.expiry_date,
        )
    )
    if existing:
        previous = existing.quantity
        existing.quantity += payload.quantity
        existing.purchase_price = payload.purchase_price
        batch = existing
    else:
        previous = Decimal("0")
        batch = Batch(
            store_id=user.store_id,
            product_id=product.id,
            **payload.model_dump(exclude={"product_id", "reference"}),
        )
        db.add(batch)
        db.flush()
    db.add(
        StockMovement(
            store_id=user.store_id,
            batch_id=batch.id,
            product_id=product.id,
            user_id=user.id,
            movement_type=MovementType.RECEIPT,
            quantity_change=payload.quantity,
            previous_quantity=previous,
            new_quantity=batch.quantity,
            reason="Supplier stock-in",
            reference=payload.reference,
        )
    )
    stock_value = (payload.quantity * payload.purchase_price).quantize(Decimal("0.01"))
    if stock_value:
        db.add_all([
            LedgerEntry(
                store_id=user.store_id,
                supplier_id=payload.supplier_id,
                account="inventory",
                entry_type="stock_receipt",
                debit=stock_value,
                credit=Decimal("0"),
                reference=payload.reference or batch.batch_number,
                description=f"Stock received for {product.sku}.",
                created_by=user.id,
            ),
            LedgerEntry(
                store_id=user.store_id,
                supplier_id=payload.supplier_id,
                account="accounts_payable" if payload.supplier_id else "inventory_opening",
                entry_type="stock_receipt",
                debit=Decimal("0"),
                credit=stock_value,
                reference=payload.reference or batch.batch_number,
                description=f"Stock receipt offset for {product.sku}.",
                created_by=user.id,
            ),
        ])
    record_audit(
        db,
        user,
        "stock.received",
        "batch",
        batch.id,
        f"{payload.quantity} units received for {product.sku}; batch {batch.batch_number}.",
    )
    db.commit()
    db.refresh(batch)
    return batch


@router.post("/inventory/adjustments", response_model=StockMovementRead)
def adjust_stock(
    payload: StockAdjustment,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*STOCK_ROLES)),
) -> StockMovement:
    reason_code = payload.reason_code.strip().lower()
    if reason_code not in EXPIRY_REASONS:
        raise HTTPException(status_code=422, detail="Choose a valid stock adjustment reason.")
    if payload.direction not in {"add", "remove"}:
        raise HTTPException(status_code=422, detail="Direction must be add or remove.")
    batch = db.scalar(
        select(Batch)
        .where(Batch.id == payload.batch_id, Batch.store_id == user.store_id)
        .with_for_update()
    )
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch not found.")
    change = payload.quantity if payload.direction == "add" else -payload.quantity
    new_quantity = batch.quantity + change
    if new_quantity < 0:
        raise HTTPException(
            status_code=409,
            detail=f"Adjustment exceeds available stock ({batch.quantity}).",
        )
    if payload.direction == "add" and batch.expiry_date < date.today():
        raise HTTPException(status_code=409, detail="Expired stock cannot be returned to sellable inventory.")
    previous = batch.quantity
    batch.quantity = new_quantity
    movement = StockMovement(
        store_id=user.store_id,
        batch_id=batch.id,
        product_id=batch.product_id,
        user_id=user.id,
        movement_type=MovementType.ADJUSTMENT,
        quantity_change=change,
        previous_quantity=previous,
        new_quantity=new_quantity,
        reason=f"{reason_code}: {payload.notes.strip()}".rstrip(": "),
        reference=str(batch.id),
    )
    db.add(movement)
    adjustment_value = (payload.quantity * batch.purchase_price).quantize(Decimal("0.01"))
    if adjustment_value:
        adding_stock = payload.direction == "add"
        db.add_all([
            LedgerEntry(
                store_id=user.store_id,
                account="inventory" if adding_stock else "stock_adjustment_expense",
                entry_type="stock_adjustment",
                debit=adjustment_value,
                credit=Decimal("0"),
                reference=str(batch.id),
                description=f"{reason_code}: {payload.notes.strip()}".rstrip(": "),
                created_by=user.id,
            ),
            LedgerEntry(
                store_id=user.store_id,
                account="stock_adjustment_gain" if adding_stock else "inventory",
                entry_type="stock_adjustment",
                debit=Decimal("0"),
                credit=adjustment_value,
                reference=str(batch.id),
                description=f"{reason_code}: {payload.notes.strip()}".rstrip(": "),
                created_by=user.id,
            ),
        ])
    record_audit(
        db,
        user,
        "stock.adjusted",
        "batch",
        batch.id,
        f"{change} units; {movement.reason}.",
    )
    db.commit()
    db.refresh(movement)
    return movement


@router.get("/inventory/movements", response_model=list[StockMovementRead])
def list_movements(
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[StockMovement]:
    return list(
        db.scalars(
            select(StockMovement)
            .where(StockMovement.store_id == user.store_id)
            .order_by(StockMovement.created_at.desc())
            .limit(limit)
        ).all()
    )
