"""Seed clearly labeled synthetic pharmacy products and sales in a local demo."""

import json
import os
import urllib.error
import urllib.request
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

API_BASE = os.getenv("DEMO_API_URL", "http://127.0.0.1:8000").rstrip("/")
EMAIL = os.getenv("DEMO_ADMIN_EMAIL")
PASSWORD = os.getenv("DEMO_ADMIN_PASSWORD")

MEDICINES = [
    ("Paracetamol", "Analgesic", "tablet"),
    ("Ibuprofen", "Analgesic", "tablet"),
    ("Amoxicillin", "Antibiotic", "capsule"),
    ("Cetirizine", "Allergy care", "tablet"),
    ("Omeprazole", "Digestive care", "capsule"),
    ("Metformin", "Chronic care", "tablet"),
    ("Atorvastatin", "Chronic care", "tablet"),
    ("Amlodipine", "Chronic care", "tablet"),
    ("Losartan", "Chronic care", "tablet"),
    ("Salbutamol", "Respiratory care", "tablet"),
    ("Azithromycin", "Antibiotic", "tablet"),
    ("Diclofenac", "Analgesic", "tablet"),
    ("Folic acid", "Vitamin", "tablet"),
    ("Vitamin C", "Vitamin", "tablet"),
    ("Dextromethorphan", "Respiratory care", "syrup"),
    ("Multivitamin", "Vitamin", "tablet"),
    ("Clotrimazole", "Skin care", "cream"),
    ("Hydrocortisone", "Skin care", "cream"),
    ("Cefixime", "Antibiotic", "capsule"),
    ("Pantoprazole", "Digestive care", "tablet"),
    ("Montelukast", "Respiratory care", "tablet"),
    ("Calcium", "Vitamin", "tablet"),
    ("Zinc", "Vitamin", "tablet"),
    ("Oral rehydration salts", "Hydration", "sachet"),
    ("Loratadine", "Allergy care", "tablet"),
]
STRENGTHS = ("100 mg", "250 mg", "500 mg", "10 mg")


def request(path: str, token: str, payload: dict | None = None, key: str | None = None):
    headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode()
    if key:
        headers["Idempotency-Key"] = key
    req = urllib.request.Request(f"{API_BASE}{path}", data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.loads(response.read()) if response.status != 204 else None
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{path} failed ({error.code}): {detail}") from error


def money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def main() -> None:
    if not EMAIL or not PASSWORD:
        raise SystemExit(
            "Set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD to the local owner login first."
        )
    login_request = urllib.request.Request(
        f"{API_BASE}/api/auth/login",
        data=json.dumps({"email": EMAIL, "password": PASSWORD}).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(login_request, timeout=20) as response:
            token = json.loads(response.read())["access_token"]
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Local pharmacy sign-in failed ({error.code}): {detail}") from error

    existing = request("/api/products", token)
    by_sku = {product["sku"]: product for product in existing}
    medicines = []
    for index in range(100):
        generic, category, unit = MEDICINES[index % len(MEDICINES)]
        strength = STRENGTHS[index // len(MEDICINES)]
        sku = f"DEMO-{index + 1:04d}"
        product = by_sku.get(sku)
        if product is None:
            cost = Decimal(50 + (index % 30) * 5)
            sale_price = money(cost * Decimal("1.35"))
            product = request("/api/products", token, {
                "sku": sku,
                "name": f"DEMO - {generic} {strength} Sample",
                "generic_name": f"{generic} (synthetic demo record)",
                "category": category,
                "manufacturer": "DEMO DATA ONLY",
                "barcode": f"DEMO{index + 1:010d}",
                "unit": unit,
                "pack_size": 10,
                "purchase_price": str(cost),
                "sale_price": str(sale_price),
                "tax_rate": "0",
                "reorder_level": "5",
                "shelf_location": f"DEMO-{index // 20 + 1}-{index % 20 + 1:02d}",
            })
        medicines.append(product)

    expiry = (date.today() + timedelta(days=700)).isoformat()
    batches = request("/api/batches?include_empty=true", token)
    existing_batch_numbers = {batch["batch_number"] for batch in batches}
    for index, product in enumerate(medicines):
        batch_number = f"DEMO-BATCH-{index + 1:04d}"
        if batch_number not in existing_batch_numbers:
            request("/api/batches/receive", token, {
                "product_id": product["id"],
                "batch_number": batch_number,
                "expiry_date": expiry,
                "quantity": str(20 + index % 31),
                "purchase_price": str(product["purchase_price"]),
                "reference": "LOCAL SYNTHETIC DEMO SEED",
            })

    customers = request("/api/customers?search=Demo%20Credit%20Customer", token)
    customer = next(
        (item for item in customers if item["name"] == "Demo Credit Customer"),
        None,
    )
    if customer is None:
        customer = request("/api/customers", token, {
            "name": "Demo Credit Customer",
            "credit_limit": "100000",
        })

    supplier_name = "Demo Supplier - Sample"
    suppliers = request("/api/suppliers?search=Demo%20Supplier", token)
    supplier = next((item for item in suppliers if item["name"] == supplier_name), None)
    if supplier is None:
        supplier = request("/api/suppliers", token, {
            "name": supplier_name,
            "contact_name": "DEMO DATA ONLY",
        })

    supplier_invoice = "DEMO-SUPPLIER-INVOICE-001"
    purchases = request("/api/purchases", token)
    purchase = next(
        (item for item in purchases if item["supplier_invoice"] == supplier_invoice),
        None,
    )
    if purchase is None:
        supplier_product = medicines[99]
        purchase = request("/api/purchases", token, {
            "supplier_id": supplier["id"],
            "supplier_invoice": supplier_invoice,
            "due_date": (date.today() + timedelta(days=30)).isoformat(),
            "notes": "Synthetic local demo payable; not a real supplier invoice.",
            "lines": [{
                "product_id": supplier_product["id"],
                "batch_number": "DEMO-SUPPLIER-BATCH-001",
                "expiry_date": expiry,
                "quantity_ordered": "12",
                "unit_cost": str(supplier_product["purchase_price"]),
            }],
        })
    purchase_lines = request(f"/api/purchases/{purchase['id']}/lines", token)
    for line in purchase_lines:
        remaining = Decimal(str(line["quantity_ordered"])) - Decimal(str(line["quantity_received"]))
        if remaining > 0:
            request(
                f"/api/purchases/{purchase['id']}/receive",
                token,
                {"line_id": line["id"], "quantity": str(remaining)},
            )

    sales = [
        (1, 2, "cash", False),
        (8, 1, "card", False),
        (19, 1, "mobile_wallet", True),
        (34, 1, "cash", True),
        (57, 3, "cash", False),
        (82, 2, "card", False),
    ]
    for sample_no, (product_index, quantity, payment_method, on_credit) in enumerate(sales, 1):
        product = medicines[product_index]
        total = money(Decimal(str(product["sale_price"])) * quantity)
        if on_credit:
            credit = money(total / 2)
            payments = [
                {"method": payment_method, "amount": str(total - credit), "reference": "DEMO PAID PORTION"},
                {"method": "credit", "amount": str(credit), "reference": "DEMO UDHAAR"},
            ]
            sale_customer = customer["id"]
        else:
            payments = [{"method": payment_method, "amount": str(total), "reference": "DEMO PAYMENT"}]
            sale_customer = None
        request(
            "/api/sales",
            token,
            {
                "customer_id": sale_customer,
                "lines": [{"product_id": product["id"], "quantity": str(quantity), "discount": "0"}],
                "payments": payments,
            },
            key=f"LOCAL-DEMO-SALE-{sample_no:04d}",
        )
    print(f"Local demo seeding complete: {len(medicines)} synthetic medicines, 6 sample sales.")
    print("Some demo sales use customer credit so the owner can review udhaar and reminders.")
    print("A synthetic supplier invoice is received on credit to demonstrate payables.")
    print("Every seeded product is named DEMO and has a DEMO batch/barcode; do not dispense it.")


if __name__ == "__main__":
    main()
