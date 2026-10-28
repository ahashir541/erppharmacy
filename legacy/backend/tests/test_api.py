import os
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

os.environ.setdefault("JWT_SECRET_KEY", "test-secret-with-more-than-thirty-two-characters")

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import Settings, settings
from app.database import Base, get_db
from app.main import app
from app.models import (
    Batch,
    LedgerEntry,
    PlatformOperator,
    Product,
    Store,
    TenantStatus,
    User,
    UserRole,
)
from app.schemas import SaleCreate
from app.security import hash_password


def setup_client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_sessions = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    with testing_sessions.begin() as db:
        store = Store(name="Test Pharmacy")
        db.add(store)
        db.flush()
        user = User(
            store_id=store.id,
            name="Test Administrator",
            email="admin@test.example",
            password_hash=hash_password("test-password-123"),
            role=UserRole.OWNER,
        )
        other_store = Store(name="Other Pharmacy")
        db.add_all([user, other_store])
        db.flush()
        other_user = User(
            store_id=other_store.id,
            name="Other Admin",
            email="other@test.example",
            password_hash=hash_password("test-password-123"),
            role=UserRole.OWNER,
        )
        db.add(other_user)
        foreign_store_id = other_store.id

    def override_get_db():
        with testing_sessions() as db:
            yield db

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    response = client.post(
        "/api/auth/login",
        json={"email": "admin@test.example", "password": "test-password-123"},
    )
    assert response.status_code == 200
    client.headers["Authorization"] = f"Bearer {response.json()['access_token']}"
    return client, testing_sessions, engine, foreign_store_id


def teardown_client(engine):
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)
    engine.dispose()


def test_environment_origin_lists_accept_comma_separated_values():
    config = Settings(
        _env_file=None,
        jwt_secret_key="test-secret-with-more-than-thirty-two-characters",
        trusted_host_origins="localhost, 192.168.1.20",
        cors_origins="http://localhost:5173, http://192.168.1.20:5173",
    )
    assert config.trusted_host_origins == ["localhost", "192.168.1.20"]
    assert config.cors_origins == [
        "http://localhost:5173",
        "http://192.168.1.20:5173",
    ]
    assert config.bootstrap_platform_name == "Syed Hashir Ali"


def test_sale_payload_has_bounded_line_and_payment_counts():
    line = {
        "product_id": "00000000-0000-0000-0000-000000000001",
        "quantity": "1",
    }
    payment = {"method": "cash", "amount": "1"}
    for lines, payments in [
        ([line] * 501, [payment]),
        ([line], [payment] * 11),
    ]:
        try:
            SaleCreate.model_validate({"lines": lines, "payments": payments})
        except ValueError:
            continue
        raise AssertionError("Oversized sale payload should be rejected.")


def test_health_login_and_fefo_checkout_only_post_receivable_once():
    client, sessions, engine, _ = setup_client()
    try:
        assert client.get("/health").json() == {"status": "ok"}
        product_response = client.post("/api/products", json={
            "sku": "AMX-001",
            "name": "Amoxicillin 250 mg",
            "generic_name": "Amoxicillin",
            "category": "Antibiotic",
            "unit": "box",
            "pack_size": 10,
            "purchase_price": "4.00",
            "sale_price": "10.00",
            "tax_rate": "5",
            "reorder_level": "2",
            "barcode": "00001234",
        })
        assert product_response.status_code == 201
        product = product_response.json()
        assert Decimal(product["stock"]) == 0
        assert product["barcode"] == "00001234"

        customer_response = client.post("/api/customers", json={
            "name": "Credit Customer",
            "phone": "555-0100",
            "credit_limit": "100.00",
        })
        assert customer_response.status_code == 201
        customer_id = customer_response.json()["id"]
        today = date.today()
        received_batch_ids = {}
        for batch_number, expiry, quantity in [
            ("EARLY", today + timedelta(days=60), "2"),
            ("LATE", today + timedelta(days=180), "5"),
        ]:
            response = client.post("/api/batches/receive", json={
                "product_id": product["id"],
                "batch_number": batch_number,
                "expiry_date": expiry.isoformat(),
                "quantity": quantity,
                "purchase_price": "4.00",
            })
            assert response.status_code == 201, response.text
            received_batch_ids[batch_number] = response.json()["id"]

        sale_payload = {
            "customer_id": customer_id,
            "lines": [{"product_id": product["id"], "quantity": "3", "discount": "0"}],
            "payments": [
                {"method": "cash", "amount": "10.50"},
                {"method": "credit", "amount": "21.00"},
            ],
        }
        idempotency_headers = {"Idempotency-Key": "test-checkout-key-0001"}
        sale_response = client.post(
            "/api/sales",
            json=sale_payload,
            headers=idempotency_headers,
        )
        assert sale_response.status_code == 201, sale_response.text
        repeated_sale = client.post(
            "/api/sales",
            json=sale_payload,
            headers=idempotency_headers,
        )
        assert repeated_sale.status_code == 201, repeated_sale.text
        assert repeated_sale.json()["id"] == sale_response.json()["id"]
        changed_retry = client.post(
            "/api/sales",
            json={
                **sale_payload,
                "lines": [{"product_id": product["id"], "quantity": "2", "discount": "0"}],
            },
            headers=idempotency_headers,
        )
        assert changed_retry.status_code == 409
        updated_batches = client.get(
            "/api/batches",
            params={"product_id": product["id"], "include_empty": "true"},
        )
        assert updated_batches.status_code == 200
        assert [(row["batch_number"], Decimal(row["quantity"])) for row in updated_batches.json()] == [
            ("EARLY", Decimal("0.000")),
            ("LATE", Decimal("4.000")),
        ]

        ledger = client.get(f"/api/customers/{customer_id}/ledger")
        assert ledger.status_code == 200
        assert Decimal(str(ledger.json()["balance"])) == Decimal("21.00")
        credit_accounts = client.get("/api/credit-balances")
        assert credit_accounts.status_code == 200
        customer_credit = next(
            row for row in credit_accounts.json()["customers"] if row["id"] == customer_id
        )
        assert Decimal(str(customer_credit["balance"])) == Decimal("21.00")
        assert Decimal(str(customer_credit["credit_sales"][0]["outstanding"])) == Decimal("21.00")
        assert customer_credit["credit_sales"][0]["items"][0]["name"] == "Amoxicillin 250 mg"
        failed_sale = client.post("/api/sales", json={
            "customer_id": customer_id,
            "lines": [{"product_id": product["id"], "quantity": "5", "discount": "0"}],
            "payments": [{"method": "cash", "amount": "52.50"}],
        })
        assert failed_sale.status_code == 409
        adjustment = client.post("/api/inventory/adjustments", json={
            "batch_id": received_batch_ids["LATE"],
            "direction": "remove",
            "quantity": "1",
            "reason_code": "damage",
            "notes": "Damaged packaging",
        })
        assert adjustment.status_code == 200

        supplier_response = client.post("/api/suppliers", json={"name": "Reliable Supplier"})
        assert supplier_response.status_code == 201
        supplier_id = supplier_response.json()["id"]
        purchase_response = client.post("/api/purchases", json={
            "supplier_id": supplier_id,
            "supplier_invoice": "SUP-100",
            "lines": [{
                "product_id": product["id"],
                "batch_number": "PURCHASE-1",
                "expiry_date": (today + timedelta(days=360)).isoformat(),
                "quantity_ordered": "3",
                "unit_cost": "4.00",
            }],
        })
        assert purchase_response.status_code == 201, purchase_response.text
        purchase = purchase_response.json()
        purchase_lines = client.get(f"/api/purchases/{purchase['id']}/lines")
        assert purchase_lines.status_code == 200
        line = purchase_lines.json()[0]
        for quantity in ("1", "2"):
            receive_response = client.post(
                f"/api/purchases/{purchase['id']}/receive",
                json={"line_id": line["id"], "quantity": quantity},
            )
            assert receive_response.status_code == 200, receive_response.text
        supplier_ledger = client.get(f"/api/suppliers/{supplier_id}/ledger")
        assert supplier_ledger.status_code == 200
        assert Decimal(str(supplier_ledger.json()["balance"])) == Decimal("12.60")
        credit_accounts = client.get("/api/credit-balances")
        supplier_credit = next(
            row for row in credit_accounts.json()["suppliers"] if row["id"] == supplier_id
        )
        assert Decimal(str(supplier_credit["balance"])) == Decimal("12.60")
        assert Decimal(str(supplier_credit["open_purchases"][0]["outstanding"])) == Decimal("12.60")

        with sessions() as db:
            receivable_debits = db.scalar(
                select(func.sum(LedgerEntry.debit)).where(
                    LedgerEntry.customer_id.is_not(None),
                    LedgerEntry.account == "accounts_receivable",
                )
            )
            assert Decimal(receivable_debits) == Decimal("21.00")
            total_debits = db.scalar(select(func.sum(LedgerEntry.debit)))
            total_credits = db.scalar(select(func.sum(LedgerEntry.credit)))
            assert Decimal(total_debits) == Decimal(total_credits)
            early_stock = db.get(Batch, UUID(received_batch_ids["EARLY"]))
            late_stock = db.get(Batch, UUID(received_batch_ids["LATE"]))
            assert early_stock.quantity == 0
            assert late_stock.quantity == 3
    finally:
        teardown_client(engine)


def test_store_scope_and_role_permissions_are_enforced():
    client, sessions, engine, foreign_store_id = setup_client()
    try:
        response = client.post("/api/products", json={
            "sku": "OTHER-001", "name": "Foreign product",
        })
        assert response.status_code == 201
        with sessions.begin() as db:
            foreign_product = Product(
                store_id=foreign_store_id,
                sku="FOREIGN-001",
                name="Foreign store medicine",
            )
            cashier = User(
                store_id=foreign_store_id,
                name="Counter Cashier",
                email="cashier@test.example",
                password_hash=hash_password("cashier-password-123"),
                role=UserRole.CASHIER,
            )
            db.add_all([foreign_product, cashier])
            db.flush()
            foreign_product_id = foreign_product.id
            cashier_id = cashier.id

        products = client.get("/api/products")
        assert products.status_code == 200
        assert all(item["id"] != str(foreign_product_id) for item in products.json())
        duplicate_login = client.post("/api/users", json={
            "name": "Second Store Account",
            "email": "other@test.example",
            "password": "another-test-password",
            "role": "cashier",
        })
        assert duplicate_login.status_code == 409
        with sessions() as db:
            cashier = db.get(User, cashier_id)
            store_id = cashier.store_id
            cashier_id_saved = cashier.id
        from app.security import create_access_token

        cashier_client = TestClient(app)
        cashier_client.headers["Authorization"] = f"Bearer {create_access_token(cashier_id_saved)}"
        dashboard = cashier_client.get("/api/dashboard")
        assert dashboard.status_code == 200
        assert dashboard.json()["receivables"] is None
        assert dashboard.json()["cash_balance"] is None
        assert "profit" not in dashboard.json()["trend"][0]
        response = cashier_client.post("/api/products", json={
            "sku": "DENIED-001", "name": "Restricted product",
        })
        assert response.status_code == 403
        assert store_id == foreign_store_id
    finally:
        teardown_client(engine)


def test_journal_must_balance_and_refuse_duplicate_debit_credit_line():
    client, _, engine, _ = setup_client()
    try:
        unbalanced = client.post("/api/ledger/journals", json={
            "description": "Invalid posting",
            "lines": [
                {"account": "cash", "debit": "10.00", "credit": "0"},
                {"account": "revenue", "debit": "0", "credit": "9.00"},
            ],
        })
        assert unbalanced.status_code == 422
        balanced = client.post("/api/ledger/journals", json={
            "description": "Opening entry",
            "lines": [
                {"account": "cash", "debit": "10.00", "credit": "0"},
                {"account": "opening_equity", "debit": "0", "credit": "10.00"},
            ],
        })
        assert balanced.status_code == 201
        assert balanced.json()["debit_total"] == "10.00"
        assert balanced.json()["credit_total"] == "10.00"
    finally:
        teardown_client(engine)


def test_opening_customer_and_supplier_balances_create_balanced_ledger_entries():
    client, sessions, engine, _ = setup_client()
    try:
        customer = client.post("/api/customers", json={
            "name": "Opening Balance Customer",
            "opening_balance": "12.00",
            "credit_limit": "100.00",
        })
        supplier = client.post("/api/suppliers", json={
            "name": "Opening Balance Supplier",
            "opening_balance": "18.00",
        })
        assert customer.status_code == 201
        assert supplier.status_code == 201
        customer_statement = client.get(f"/api/customers/{customer.json()['id']}/ledger")
        supplier_statement = client.get(f"/api/suppliers/{supplier.json()['id']}/ledger")
        assert Decimal(str(customer_statement.json()["balance"])) == Decimal("12.00")
        assert Decimal(str(supplier_statement.json()["balance"])) == Decimal("18.00")
        dashboard = client.get("/api/dashboard")
        assert Decimal(str(dashboard.json()["receivables"])) == Decimal("12.00")
        assert Decimal(str(dashboard.json()["payables"])) == Decimal("18.00")
        with sessions() as db:
            debit_total = db.scalar(select(func.sum(LedgerEntry.debit)))
            credit_total = db.scalar(select(func.sum(LedgerEntry.credit)))
            assert Decimal(debit_total) == Decimal(credit_total)
    finally:
        teardown_client(engine)


def test_expense_date_filters_and_dashboard_management_periods():
    client, _, engine, _ = setup_client()
    try:
        today = date.today().isoformat()
        expense = client.post("/api/expenses", json={
            "category": "Utilities",
            "description": "Daily power bill",
            "amount": "125.50",
            "payment_method": "cash",
        })
        assert expense.status_code == 201, expense.text
        expenses_today = client.get(
            "/api/expenses",
            params={
                "start_date": today,
                "end_date": today,
                "timezone_name": "Asia/Karachi",
            },
        )
        assert expenses_today.status_code == 200
        assert len(expenses_today.json()) == 1
        assert Decimal(expenses_today.json()[0]["amount"]) == Decimal("125.50")
        assert client.get(
            "/api/expenses",
            params={"start_date": "2026-09-30", "end_date": "2026-09-01"},
        ).status_code == 422

        for period in ("weekly", "monthly", "yearly"):
            dashboard = client.get(
                "/api/dashboard",
                params={"period": period, "timezone_name": "Asia/Karachi"},
            )
            assert dashboard.status_code == 200
            assert dashboard.json()["management"]["period"] == period
            assert Decimal(dashboard.json()["management"]["expenses"]) == Decimal("125.50")
            assert dashboard.json()["management"]["transactions"] == 0
        assert client.get("/api/dashboard", params={"period": "quarterly"}).status_code == 422
    finally:
        teardown_client(engine)


def test_platform_onboarding_isolates_pharmacies_and_suspension_revokes_tenant_access(monkeypatch):
    client, sessions, engine, _ = setup_client()
    try:
        operator_password = "platform-owner-test-password"
        with sessions.begin() as db:
            db.add(
                PlatformOperator(
                    name="MedFlow Owner",
                    email="platform@test.example",
                    password_hash=hash_password(operator_password),
                )
            )
            db.add(
                PlatformOperator(
                    name="Unauthorized Platform Account",
                    email="another-operator@test.example",
                    password_hash=hash_password("another-operator-password"),
                )
            )
        monkeypatch.setattr(settings, "bootstrap_platform_email", "platform@test.example")
        platform = TestClient(app)
        platform_login = platform.post(
            "/api/platform/auth/login",
            json={"email": "platform@test.example", "password": operator_password},
        )
        assert platform_login.status_code == 200
        rejected_platform_login = platform.post("/api/platform/auth/login", json={
            "email": "another-operator@test.example",
            "password": "another-operator-password",
        })
        assert rejected_platform_login.status_code == 401
        platform.headers["Authorization"] = f"Bearer {platform_login.json()['access_token']}"
        password_change = platform.post("/api/platform/auth/password", json={
            "current_password": operator_password,
            "new_password": "updated-platform-owner-password",
        })
        assert password_change.status_code == 204
        assert platform.get("/api/platform/tenants").status_code == 401
        rotated_login = platform.post("/api/platform/auth/login", json={
            "email": "platform@test.example",
            "password": "updated-platform-owner-password",
        })
        assert rotated_login.status_code == 200
        platform.headers["Authorization"] = f"Bearer {rotated_login.json()['access_token']}"

        created = platform.post("/api/platform/tenants", json={
            "pharmacy_name": "Northside Pharmacy",
            "administrator_name": "Northside Owner",
            "administrator_email": "owner@northsidepharmacy.com",
            "administrator_password": "northside-temporary-password",
            "plan_code": "professional",
            "trial_days": 14,
        })
        assert created.status_code == 201, created.text
        tenant_id = UUID(created.json()["pharmacy"]["id"])
        assert created.json()["pharmacy"]["status"] == "trial"
        assert created.json()["administrator"]["role"] == "owner"
        masterboard = platform.get(
            "/api/platform/tenants",
            params={"timezone_name": "Asia/Karachi"},
        )
        northside = next(
            row for row in masterboard.json() if row["id"] == str(tenant_id)
        )
        assert northside["today_sales"] == "0"
        assert northside["medicine_count"] == 0
        assert northside["low_stock_products"] == 0

        tenant_client = TestClient(app)
        login = tenant_client.post(
            "/api/auth/login",
            json={
                "email": "owner@northsidepharmacy.com",
                "password": "northside-temporary-password",
            },
        )
        assert login.status_code == 200
        tenant_client.headers["Authorization"] = f"Bearer {login.json()['access_token']}"
        assert tenant_client.get("/api/products").json() == []
        assert tenant_client.get("/api/platform/tenants").status_code == 401
        assert client.get("/api/platform/tenants").status_code == 401

        monkeypatch.setattr(settings, "billing_jazzcash_account_name", "MedFlow")
        monkeypatch.setattr(settings, "billing_jazzcash_account_number", "03000000000")
        invoice_response = platform.post(f"/api/platform/tenants/{tenant_id}/invoices", json={
            "plan_code": "professional",
            "amount": "15000.00",
            "duration_days": 30,
            "due_days": 7,
        })
        assert invoice_response.status_code == 201, invoice_response.text
        invoice = invoice_response.json()
        assert invoice["currency"] == "PKR"
        assert invoice["status"] == "due"
        invoices = tenant_client.get("/api/billing/invoices")
        assert invoices.status_code == 200
        assert [item["id"] for item in invoices.json()] == [invoice["id"]]
        instructions = tenant_client.get("/api/billing/payment-instructions")
        assert instructions.status_code == 200
        assert instructions.json()[0]["method"] == "jazzcash"
        assert client.get("/api/billing/invoices").json() == []
        premature_approval = platform.patch(
            f"/api/platform/invoices/{invoice['id']}/review",
            json={"status": "paid", "note": "Not yet verified."},
        )
        assert premature_approval.status_code == 409
        unavailable_method = tenant_client.post(
            f"/api/billing/invoices/{invoice['id']}/payment",
            json={
                "method": "easypaisa",
                "paid_amount": "15000.00",
                "reference": "EP-TRANSACTION-1000",
            },
        )
        assert unavailable_method.status_code == 422
        wrong_amount = tenant_client.post(
            f"/api/billing/invoices/{invoice['id']}/payment",
            json={
                "method": "jazzcash",
                "paid_amount": "14999.00",
                "reference": "JC-TRANSACTION-1000",
            },
        )
        assert wrong_amount.status_code == 422
        payment_submission = tenant_client.post(
            f"/api/billing/invoices/{invoice['id']}/payment",
            json={
                "method": "jazzcash",
                "paid_amount": "15000.00",
                "reference": "JC-TRANSACTION-1001",
            },
        )
        assert payment_submission.status_code == 200, payment_submission.text
        assert payment_submission.json()["status"] == "submitted"
        approved = platform.patch(
            f"/api/platform/invoices/{invoice['id']}/review",
            json={"status": "paid", "note": "Transfer verified in the wallet account."},
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "paid"
        assert tenant_client.get("/api/products").status_code == 200

        tenants = platform.get("/api/platform/tenants")
        assert tenants.status_code == 200
        assert any(row["id"] == str(tenant_id) for row in tenants.json())
        with sessions.begin() as db:
            store = db.get(Store, tenant_id)
            store.tenant_status = TenantStatus.TRIAL
            store.trial_ends_at = datetime.now(timezone.utc) - timedelta(days=1)
        response = tenant_client.get("/api/products")
        assert response.status_code == 402
        expired_login = TestClient(app).post(
            "/api/auth/login",
            json={
                "email": "owner@northsidepharmacy.com",
                "password": "northside-temporary-password",
            },
        )
        assert expired_login.status_code == 200
        resumed = platform.patch(f"/api/platform/tenants/{tenant_id}", json={
            "status": "active",
            "plan_code": "enterprise",
        })
        assert resumed.status_code == 200
        assert tenant_client.get("/api/products").status_code == 200
        suspended = platform.patch(f"/api/platform/tenants/{tenant_id}", json={
            "status": "suspended",
            "plan_code": "enterprise",
        })
        assert suspended.status_code == 200
        assert tenant_client.get("/api/products").status_code == 402
        assert tenant_client.get("/api/auth/me").status_code == 200
        assert tenant_client.get("/api/billing/invoices").status_code == 200
        assert tenant_client.get("/api/billing/status").json()["restricted"] is True
    finally:
        teardown_client(engine)


def test_password_rotation_revokes_existing_bearer_tokens():
    client, _, engine, _ = setup_client()
    try:
        response = client.post("/api/auth/password", json={
            "current_password": "test-password-123",
            "new_password": "updated-test-password-456",
        })
        assert response.status_code == 204
        assert client.get("/api/auth/me").status_code == 401
        login = client.post("/api/auth/login", json={
            "email": "admin@test.example",
            "password": "updated-test-password-456",
        })
        assert login.status_code == 200
        client.headers["Authorization"] = f"Bearer {login.json()['access_token']}"
        assert client.get("/api/auth/me").status_code == 200
    finally:
        teardown_client(engine)


def test_owner_only_financial_views_and_staff_pos_access():
    client, _, engine, _ = setup_client()
    try:
        product = client.post("/api/products", json={
            "sku": "STAFF-001",
            "name": "Demo Fever Relief",
            "unit": "box",
            "purchase_price": "2.00",
            "sale_price": "5.00",
            "tax_rate": "0",
        }).json()
        receipt = client.post("/api/batches/receive", json={
            "product_id": product["id"],
            "batch_number": "STAFF-DEMO-BATCH",
            "expiry_date": (date.today() + timedelta(days=365)).isoformat(),
            "quantity": "10",
            "purchase_price": "2.00",
        })
        assert receipt.status_code == 201
        cashier = client.post("/api/users", json={
            "name": "Counter Staff",
            "email": "counter@test.example",
            "password": "counter-password-123",
            "role": "cashier",
        })
        assert cashier.status_code == 201
        owner_assignment = client.post("/api/users", json={
            "name": "Second Owner",
            "email": "second-owner@test.example",
            "password": "second-owner-password-123",
            "role": "owner",
        })
        assert owner_assignment.status_code == 422
        staff = TestClient(app)
        response = staff.post("/api/auth/login", json={
            "email": "counter@test.example",
            "password": "counter-password-123",
        })
        assert response.status_code == 200
        staff.headers["Authorization"] = f"Bearer {response.json()['access_token']}"
        customer = client.post("/api/customers", json={
            "name": "Private Credit Customer",
            "phone": "",
            "credit_limit": "250",
            "opening_balance": "50",
        })
        assert customer.status_code == 201
        masked_customer = staff.get("/api/customers").json()[0]
        assert masked_customer["credit_limit"] is None
        assert masked_customer["opening_balance"] is None
        products = staff.get("/api/products")
        assert products.status_code == 200
        assert products.json()[0]["purchase_price"] is None
        assert products.json()[0]["inventory_value"] is None
        batches = staff.get("/api/batches?include_empty=true")
        assert batches.status_code == 200
        assert batches.json()[0]["purchase_price"] is None
        dashboard = staff.get("/api/dashboard")
        assert dashboard.status_code == 200
        assert dashboard.json()["today"]["sales"] is None
        assert dashboard.json()["payment_breakdown"] == []
        assert all(item["total"] is None for item in dashboard.json()["recent_transactions"])
        assert dashboard.json()["management"]["sales"] is None
        assert dashboard.json()["management"]["expenses"] is None
        assert all(
            point["sales"] is None and point["expenses"] is None
            for point in dashboard.json()["management"]["trend"]
        )
        assert staff.get("/api/sales").status_code == 403
        assert staff.get("/api/expenses").status_code == 403
        assert staff.get("/api/credit-balances").status_code == 403
        assert staff.get("/api/users").status_code == 403
        assert staff.get("/api/purchases").status_code == 403
        assert client.get("/api/customers").json()[0]["credit_limit"] == "250.00"
        sale = staff.post("/api/sales", json={
            "lines": [{"product_id": product["id"], "quantity": "1", "discount": "0"}],
            "payments": [{"method": "cash", "amount": "5.00"}],
        })
        assert sale.status_code == 201, sale.text
        owner_dashboard = client.get("/api/dashboard")
        assert owner_dashboard.status_code == 200
        assert owner_dashboard.json()["today"]["sales"] is not None
    finally:
        teardown_client(engine)
