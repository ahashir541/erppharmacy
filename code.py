from datetime import datetime, date
import hashlib
import hmac
import os
import secrets
import pandas as pd
import streamlit as st
import urllib.parse
from streamlit.errors import StreamlitSecretNotFoundError

# Page configuration
st.set_page_config(
    page_title="Medical store workspace",
    page_icon=":material/medical_services:",
    layout="wide",
)

# --- USER & WHITELIST MANAGEMENT FILES ---
USERS_FILE = "users.csv"
WHITELIST_FILE = "whitelist.csv"


def get_secret(name, default=""):
    try:
        return st.secrets.get(name, default)
    except StreamlitSecretNotFoundError:
        return default


CLOUD_DEMO = get_secret("deployment_mode") == "demo"


def hash_password(password):
    iterations = 600_000
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, iterations
    )
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password, stored_hash):
    if stored_hash.startswith("pbkdf2_sha256$"):
        try:
            algorithm, iterations, salt, expected = stored_hash.split("$", 3)
            if algorithm != "pbkdf2_sha256":
                return False
            iteration_count = int(iterations)
            if not 100_000 <= iteration_count <= 1_000_000:
                return False
            digest = hashlib.pbkdf2_hmac(
                "sha256",
                password.encode("utf-8"),
                bytes.fromhex(salt),
                iteration_count,
            )
            return hmac.compare_digest(digest.hex(), expected)
        except (ValueError, TypeError):
            return False
    return hmac.compare_digest(
        hashlib.sha256(password.encode("utf-8")).hexdigest(), stored_hash
    )


def load_users():
    if os.path.exists(USERS_FILE):
        return pd.read_csv(USERS_FILE)

    email = get_secret("bootstrap_admin_email")
    password = get_secret("bootstrap_admin_password")
    if len(password) < 14 or not email:
        st.error(
            "No user database exists. Configure bootstrap_admin_email and a "
            "14-character bootstrap_admin_password in Streamlit Secrets."
        )
        st.stop()
    df_users = pd.DataFrame(
        [[
            "MedFlow Demo Owner",
            email,
            hash_password(password),
            "Store Owner",
            "Demo Pharmacy",
        ]],
        columns=["Name", "Email", "Password", "Role", "StoreName"],
    )
    df_users.to_csv(USERS_FILE, index=False)
    return df_users


def load_whitelist():
    if os.path.exists(WHITELIST_FILE):
        return pd.read_csv(WHITELIST_FILE)
    email = get_secret("bootstrap_admin_email")
    if not email:
        st.error(
            "No authorized-user list exists. Configure bootstrap_admin_email "
            "in Streamlit Secrets."
        )
        st.stop()
    df_wl = pd.DataFrame(
        [[email, "Demo Pharmacy"]],
        columns=["Email", "StoreName"],
    )
    df_wl.to_csv(WHITELIST_FILE, index=False)
    return df_wl


# Persistent Session State Management (Prevents reload logouts)
if "logged_in" not in st.session_state:
    st.session_state.logged_in = False
    st.session_state.user_email = ""
    st.session_state.user_role = ""
    st.session_state.store_name = ""

df_users = load_users()
df_whitelist = load_whitelist()

# --- AUTHENTICATION SCREEN ---
if not st.session_state.logged_in:
    st.markdown(
        """
        <div style="text-align: center; margin-top: 40px;">
            <h1 style="color: #60a5fa;">💊 Syed Hashir Ali Medical ERP</h1>
            <p style="color: #94a3b8;">Secure Enterprise SaaS Portal</p>
        </div>
    """,
        unsafe_allow_html=True,
    )

    col1, col2, col3 = st.columns([1, 1.2, 1])
    with col2:
        if CLOUD_DEMO:
            st.warning(
                "Demo environment only. Use synthetic data; changes may reset. "
                "Do not enter real pharmacy, patient, customer, or financial data."
            )
        auth_options = (
            ["Login"]
            if CLOUD_DEMO
            else ["Login", "Complete Registration (Authorized Users)"]
        )
        auth_mode = st.radio("Select Access Mode", auth_options, horizontal=True)

        if auth_mode == "Login":
            with st.form("login_form"):
                st.subheader("🔐 Secure Authentication")
                # Standard field names for browser password managers
                email = st.text_input("Email Address", key="login_email")
                password = st.text_input("Password", type="password", key="login_password")
                login_btn = st.form_submit_button("Access Enterprise ERP")

                if login_btn:
                    user_row = df_users[df_users["Email"] == email]
                    if (
                        not user_row.empty
                        and verify_password(password, str(user_row.iloc[0]["Password"]))
                    ):
                        if not str(user_row.iloc[0]["Password"]).startswith(
                            "pbkdf2_sha256$"
                        ):
                            df_users.loc[user_row.index[0], "Password"] = hash_password(
                                password
                            )
                            df_users.to_csv(USERS_FILE, index=False)
                        st.session_state.logged_in = True
                        st.session_state.user_email = email
                        st.session_state.user_role = user_row.iloc[0]["Role"]
                        st.session_state.store_name = user_row.iloc[0][
                            "StoreName"
                        ]
                        st.success("Authentication successful. Loading workspace...")
                        st.rerun()
                    else:
                        st.error("Invalid email address or password.")
        else:
            with st.form("register_form"):
                st.subheader("📝 Claim Authorized Store Account")
                st.info("Your email address must be authorized by the system administrator (Syed Hashir Ali) prior to registration.")
                r_name = st.text_input("Your Full Name")
                r_email = st.text_input("Authorized Email Address")
                r_pass = st.text_input("Create Secure Password", type="password")
                reg_btn = st.form_submit_button("Activate Account")

                if reg_btn:
                    if not r_email or not r_pass:
                        st.error("Email address and password are required fields.")
                    elif len(r_pass) < 12:
                        st.error("Use a password with at least 12 characters.")
                    elif r_email not in df_whitelist["Email"].values:
                        st.error("❌ Access Denied: This email address is not authorized by the administrator.")
                    elif r_email in df_users["Email"].values:
                        st.warning("⚠️ An account associated with this email already exists. Please proceed to login.")
                    else:
                        assigned_store = df_whitelist.loc[
                            df_whitelist["Email"] == r_email, "StoreName"
                        ].values[0]

                        new_user = pd.DataFrame([[
                            r_name,
                            r_email,
                            hash_password(r_pass),
                            "Store Owner",
                            assigned_store,
                        ]], columns=df_users.columns)
                        df_users = pd.concat(
                            [df_users, new_user], ignore_index=True
                        )
                        df_users.to_csv(USERS_FILE, index=False)
                        st.success(
                            "🎉 Account activated successfully! Please switch to the 'Login' tab."
                        )
    st.stop()

if CLOUD_DEMO:
    st.warning(
        "Demo environment only. Do not use real pharmacy, patient, customer, "
        "or financial data. Changes may reset."
    )

# --- SUPER ADMIN MASTER VIEW (Lifetime Access Control & Global Activity Monitoring) ---
if st.session_state.user_role == "Super Admin":
    st.subheader("👑 Super Admin Master Control Panel")
    
    col_admin1, col_admin2 = st.columns(2)
    with col_admin1:
        st.markdown("### 📋 Authorize New Store Access (Lifetime)")
        with st.form("whitelist_form"):
            new_wl_email = st.text_input("Client Email to Authorize")
            new_wl_store = st.text_input("Assigned Store Name (e.g. Al-Shifa Medical)")
            add_wl_btn = st.form_submit_button("Grant Lifetime Authorization")
            if add_wl_btn:
                if new_wl_email and new_wl_store:
                    if new_wl_email not in df_whitelist["Email"].values:
                        new_w_row = pd.DataFrame([[new_wl_email, new_wl_store]], columns=df_whitelist.columns)
                        df_whitelist = pd.concat([df_whitelist, new_w_row], ignore_index=True)
                        df_whitelist.to_csv(WHITELIST_FILE, index=False)
                        st.success(f"Successfully authorized email: {new_wl_email} with lifetime access.")
                        st.rerun()
                    else:
                        st.warning("Email already authorized.")
                else:
                    st.error("All input fields are required.")

        st.markdown("#### Currently Authorized Whitelist:")
        if not df_whitelist.empty:
            st.dataframe(df_whitelist)
            with st.form("remove_wl_form"):
                rem_wl_email = st.selectbox("Select Authorized Email to Revoke Access", df_whitelist["Email"].tolist())
                remove_wl_btn = st.form_submit_button("Revoke / Delete User Access")
                if remove_wl_btn:
                    df_whitelist = df_whitelist[df_whitelist["Email"] != rem_wl_email]
                    df_whitelist.to_csv(WHITELIST_FILE, index=False)
                    if os.path.exists(USERS_FILE):
                        df_u_temp = pd.read_csv(USERS_FILE)
                        df_u_temp = df_u_temp[df_u_temp["Email"] != rem_wl_email]
                        df_u_temp.to_csv(USERS_FILE, index=False)
                    st.success(f"Successfully revoked access for {rem_wl_email}.")
                    st.rerun()

    with col_admin2:
        st.markdown("### 📊 Global User Activity & Master Dashboard")
        st.info("Tracking total sales, revenue, and activities across all registered user stores.")
        
        all_store_sales = []
        registered_owners = df_users[df_users["Role"] != "Super Admin"]
        for idx, row in registered_owners.iterrows():
            u_email = row["Email"]
            s_id_safe = u_email.replace("@", "_").replace(".", "_")
            s_file = f"sales_{s_id_safe}.csv"
            if os.path.exists(s_file):
                try:
                    df_s_temp = pd.read_csv(s_file)
                    df_s_temp["Store Name"] = row["StoreName"]
                    df_s_temp["Owner Email"] = u_email
                    all_store_sales.append(df_s_temp)
                except Exception:
                    pass
        
        if all_store_sales:
            master_sales_df = pd.concat(all_store_sales, ignore_index=True)
            total_platform_rev = master_sales_df["Revenue"].sum() if "Revenue" in master_sales_df.columns else 0
            total_platform_sales = len(master_sales_df)
            st.metric("Global Platform Revenue", f"PKR {total_platform_rev:,.2f}")
            st.metric("Total Transactions Across All Stores", total_platform_sales)
            st.markdown("#### Master Transaction Logs:")
            st.dataframe(master_sales_df)
        else:
            st.info("No sales transactions recorded by user stores yet.")

    st.markdown("---")
    if st.button("🚪 Logout from Master Admin"):
        st.session_state.logged_in = False
        st.rerun()
    st.stop()

# --- SAFE USER-SPECIFIC FILE PATHS ---
user_safe_id = (
    st.session_state.user_email.replace("@", "_").replace(".", "_")
    if st.session_state.user_role != "Super Admin"
    else "master"
)
INV_FILE = f"inventory_{user_safe_id}.csv"
PRODUCTS_FILE = f"products_{user_safe_id}.csv"
BATCHES_FILE = f"inventory_batches_{user_safe_id}.csv"
STOCK_MOVEMENTS_FILE = f"stock_movements_{user_safe_id}.csv"
SALES_FILE = f"sales_{user_safe_id}.csv"
UDHAAR_FILE = f"udhaar_{user_safe_id}.csv"
SUP_FILE = f"suppliers_{user_safe_id}.csv"
EXP_FILE = f"expenses_{user_safe_id}.csv"


def load_inventory_data(file):
    columns = [
        "Item Code",
        "Item Name",
        "Category",
        "Batch No",
        "Expiry Date",
        "Cost Price",
        "Selling Price",
        "Stock",
        "Min Stock",
    ]
    numeric_cols = ["Cost Price", "Selling Price", "Stock", "Min Stock"]
    if os.path.exists(file):
        try:
            df = pd.read_csv(file)
            for col in columns:
                if col not in df.columns:
                    df[col] = 0 if col in numeric_cols else ""
            for col in numeric_cols:
                if col in df.columns:
                    df[col] = (
                        pd.to_numeric(df[col], errors="coerce")
                        .fillna(0)
                        .infer_objects(copy=False)
                    )
            return df
        except Exception:
            pass

    dummy_data = [
        ["MED101", "Paracetamol 500mg", "Analgesic", "B2501", "2027-12-31", 8.0, 12.0, 150, 20],
        ["MED102", "Ibuprofen 400mg", "Analgesic", "B2502", "2027-11-30", 12.0, 18.0, 85, 15],
        ["MED103", "Amoxicillin 250mg", "Antibiotic", "B2503", "2026-10-15", 25.0, 35.0, 200, 30],
        ["MED104", "Omeprazole 20mg", "Gastric", "B2504", "2028-01-20", 15.0, 22.0, 60, 10],
        ["MED105", "Cetirizine 10mg", "Antiallergic", "B2505", "2027-06-30", 3.0, 6.0, 300, 50],
        ["MED106", "Azithromycin 500mg", "Antibiotic", "B2506", "2026-09-10", 50.0, 70.0, 45, 10],
        ["MED107", "Metformin 850mg", "Diabetes", "B2507", "2028-05-12", 10.0, 15.0, 110, 20],
        ["MED108", "Disprin 300mg", "Analgesic", "B2508", "2027-03-10", 5.0, 8.0, 0, 20],
        ["MED109", "Panadol Extra", "Analgesic", "B2509", "2027-08-19", 9.0, 14.0, 0, 25],
        ["MED110", "Brufen Syrup", "Pediatric", "B2510", "2026-12-01", 45.0, 60.0, 0, 15],
    ]
    df = pd.DataFrame(dummy_data, columns=columns)
    df.to_csv(file, index=False)
    return df


PRODUCT_COLUMNS = [
    "Item Code",
    "Item Name",
    "Generic Name",
    "Category",
    "Manufacturer",
    "Barcode",
    "Unit",
    "Pack Size",
    "Cost Price",
    "Selling Price",
    "Tax Rate",
    "Min Stock",
    "Location",
]
BATCH_COLUMNS = [
    "Batch ID",
    "Item Code",
    "Batch No",
    "Expiry Date",
    "Stock",
    "Cost Price",
    "Supplier",
    "Received Date",
]
MOVEMENT_COLUMNS = [
    "Movement ID",
    "Timestamp",
    "User",
    "Movement Type",
    "Item Code",
    "Item Name",
    "Batch No",
    "Quantity Change",
    "Previous Stock",
    "New Stock",
    "Reason",
    "Reference",
]


def read_store_table(file, columns, numeric_columns=()):
    if os.path.exists(file):
        records = pd.read_csv(
            file,
            dtype={
                "Item Code": "string",
                "Batch ID": "string",
                "Batch No": "string",
                "Barcode": "string",
            },
        )
    else:
        records = pd.DataFrame(columns=columns)
    for column in columns:
        if column not in records.columns:
            records[column] = 0 if column in numeric_columns else ""
    for column in numeric_columns:
        records[column] = pd.to_numeric(records[column], errors="coerce").fillna(0)
    for column in columns:
        if column not in numeric_columns:
            records[column] = records[column].fillna("").astype(str)
    return records[columns]


def load_inventory_records(legacy_inventory):
    if os.path.exists(PRODUCTS_FILE):
        products = read_store_table(
            PRODUCTS_FILE,
            PRODUCT_COLUMNS,
            ("Pack Size", "Cost Price", "Selling Price", "Tax Rate", "Min Stock"),
        )
    else:
        product_rows = []
        for _, item in legacy_inventory.drop_duplicates("Item Code").iterrows():
            product_rows.append({
                "Item Code": str(item["Item Code"]),
                "Item Name": item["Item Name"],
                "Generic Name": "",
                "Category": item["Category"],
                "Manufacturer": "",
                "Barcode": "",
                "Unit": "Pack",
                "Pack Size": 10,
                "Cost Price": item["Cost Price"],
                "Selling Price": item["Selling Price"],
                "Tax Rate": 0,
                "Min Stock": item["Min Stock"],
                "Location": "",
            })
        products = pd.DataFrame(product_rows, columns=PRODUCT_COLUMNS)
        products.to_csv(PRODUCTS_FILE, index=False)

    if os.path.exists(BATCHES_FILE):
        batches = read_store_table(
            BATCHES_FILE,
            BATCH_COLUMNS,
            ("Stock", "Cost Price"),
        )
    else:
        batch_rows = []
        for row_number, (_, item) in enumerate(legacy_inventory.iterrows(), start=1):
            item_code = str(item["Item Code"])
            batch_number = str(item["Batch No"])
            batch_rows.append({
                "Batch ID": f"{item_code}-{row_number:04d}",
                "Item Code": item_code,
                "Batch No": batch_number,
                "Expiry Date": item["Expiry Date"],
                "Stock": item["Stock"],
                "Cost Price": item["Cost Price"],
                "Supplier": "",
                "Received Date": "",
            })
        batches = pd.DataFrame(batch_rows, columns=BATCH_COLUMNS)
        batches.to_csv(BATCHES_FILE, index=False)

    return products, batches


def inventory_summary(products, batches):
    if products.empty:
        return pd.DataFrame(
            columns=PRODUCT_COLUMNS
            + ["Batch No", "Expiry Date", "Stock", "Inventory Value"]
        )

    batch_data = batches.copy()
    batch_data["Stock"] = pd.to_numeric(batch_data["Stock"], errors="coerce").fillna(0)
    batch_data["Cost Price"] = pd.to_numeric(
        batch_data["Cost Price"], errors="coerce"
    ).fillna(0)
    batch_data["Parsed Expiry"] = pd.to_datetime(
        batch_data["Expiry Date"], errors="coerce"
    )
    batch_data["Inventory Value"] = batch_data["Stock"] * batch_data["Cost Price"]
    totals = batch_data.groupby("Item Code", as_index=False).agg(
        Stock=("Stock", "sum"),
        Inventory_Value=("Inventory Value", "sum"),
    )
    earliest_batches = (
        batch_data[batch_data["Stock"] > 0]
        .sort_values(["Parsed Expiry", "Batch ID"], na_position="last")
        .drop_duplicates("Item Code")
        [["Item Code", "Batch No", "Expiry Date"]]
    )
    result = products.merge(totals, on="Item Code", how="left")
    result = result.merge(earliest_batches, on="Item Code", how="left")
    result["Stock"] = result["Stock"].fillna(0)
    result["Inventory Value"] = result["Inventory_Value"].fillna(0)
    return result.drop(columns=["Inventory_Value"])


def sellable_stock(batches, item_code):
    product_batches = batches[batches["Item Code"].astype(str) == str(item_code)].copy()
    product_batches["Stock"] = pd.to_numeric(
        product_batches["Stock"], errors="coerce"
    ).fillna(0)
    expiries = pd.to_datetime(product_batches["Expiry Date"], errors="coerce")
    today = pd.Timestamp(date.today())
    available = product_batches["Stock"] > 0
    available &= expiries.notna() & (expiries >= today)
    return float(product_batches.loc[available, "Stock"].sum())


def allocate_fefo(batches, item_code, quantity):
    updated_batches = batches.copy()
    product_batches = updated_batches[
        updated_batches["Item Code"].astype(str) == str(item_code)
    ].copy()
    product_batches["Parsed Expiry"] = pd.to_datetime(
        product_batches["Expiry Date"], errors="coerce"
    )
    today = pd.Timestamp(date.today())
    product_batches["Stock"] = pd.to_numeric(
        product_batches["Stock"], errors="coerce"
    ).fillna(0)
    product_batches["Cost Price"] = pd.to_numeric(
        product_batches["Cost Price"], errors="coerce"
    ).fillna(0)
    sellable = product_batches[
        (product_batches["Stock"] > 0)
        & product_batches["Parsed Expiry"].notna()
        & (product_batches["Parsed Expiry"] >= today)
    ].sort_values(["Parsed Expiry", "Batch ID"], na_position="last")

    if float(sellable["Stock"].sum()) + 1e-9 < quantity:
        return None, 0.0, []

    remaining = float(quantity)
    cost = 0.0
    movements = []
    for index, batch in sellable.iterrows():
        if remaining <= 1e-9:
            break
        taken = min(float(batch["Stock"]), remaining)
        previous_stock = float(batch["Stock"])
        new_stock = previous_stock - taken
        updated_batches.loc[index, "Stock"] = new_stock
        cost += taken * float(batch["Cost Price"])
        movements.append({
            "Batch ID": batch["Batch ID"],
            "Batch No": batch["Batch No"],
            "Quantity Change": -taken,
            "Previous Stock": previous_stock,
            "New Stock": new_stock,
        })
        remaining -= taken
    return updated_batches, cost, movements


def add_stock_movements(movements):
    if not movements:
        return
    existing = read_store_table(STOCK_MOVEMENTS_FILE, MOVEMENT_COLUMNS)
    new_records = pd.DataFrame(movements, columns=MOVEMENT_COLUMNS)
    pd.concat([existing, new_records], ignore_index=True).to_csv(
        STOCK_MOVEMENTS_FILE, index=False
    )


def prepare_fefo_sale(cart_items, batches, products, sale_id, sale_time, user_email):
    updated_batches = batches.copy()
    stock_movements = []
    total_cost = 0.0
    for _, line in cart_items.iterrows():
        product_code = line.get("Product Code")
        if pd.isna(product_code) or not str(product_code).strip():
            matching_products = products[
                products["Item Name"].astype(str) == str(line["Base Name"])
            ]
            if matching_products.empty:
                return None, 0.0, [], "A cart product is missing from the catalog."
            product_code = matching_products.iloc[0]["Item Code"]

        updated_batches, line_cost, allocations = allocate_fefo(
            updated_batches,
            product_code,
            float(line["Qty Units"]),
        )
        if updated_batches is None:
            product_name = str(line.get("Base Name", product_code))
            return (
                None,
                0.0,
                [],
                f"Insufficient unexpired stock for {product_name}. Refresh the cart and try again.",
            )
        total_cost += line_cost
        product_name = products.loc[
            products["Item Code"].astype(str) == str(product_code),
            "Item Name",
        ].iloc[0]
        for allocation in allocations:
            stock_movements.append({
                "Movement ID": f"{sale_id}-STK-{len(stock_movements) + 1:03d}",
                "Timestamp": sale_time,
                "User": user_email,
                "Movement Type": "Sale",
                "Item Code": str(product_code),
                "Item Name": product_name,
                "Batch No": allocation["Batch No"],
                "Quantity Change": allocation["Quantity Change"],
                "Previous Stock": allocation["Previous Stock"],
                "New Stock": allocation["New Stock"],
                "Reason": "Point-of-sale checkout",
                "Reference": sale_id,
            })
    return updated_batches, total_cost, stock_movements, None


def load_data(file, columns, numeric_cols=[]):
    if os.path.exists(file):
        try:
            df = pd.read_csv(file)
            for col in columns:
                if col not in df.columns:
                    df[col] = 0 if col in numeric_cols else ""
            for col in numeric_cols:
                if col in df.columns:
                    df[col] = (
                        pd.to_numeric(df[col], errors="coerce")
                        .fillna(0)
                        .infer_objects(copy=False)
                    )
            return df
        except Exception:
            df = pd.DataFrame(columns=columns)
            df.to_csv(file, index=False)
            return df
    else:
        df = pd.DataFrame(columns=columns)
        df.to_csv(file, index=False)
        return df


legacy_inventory = load_inventory_data(INV_FILE)
df_products, df_batches = load_inventory_records(legacy_inventory)
df_movements = read_store_table(STOCK_MOVEMENTS_FILE, MOVEMENT_COLUMNS)
df_inv = inventory_summary(df_products, df_batches)
df_batch_view = df_batches.merge(
    df_products[["Item Code", "Item Name", "Generic Name"]],
    on="Item Code",
    how="left",
)


def queue_cart_item(item_code, quantity, display_name=None, line_suffix=None):
    item = df_inv[df_inv["Item Code"].astype(str) == str(item_code)]
    if item.empty:
        return False, "Product was not found in the inventory catalog."
    item = item.iloc[0]
    quantity = float(quantity)
    reserved = sum(
        float(line["Qty Units"])
        for line in st.session_state.cart
        if str(line.get("Product Code", "")) == str(item_code)
    )
    available = sellable_stock(df_batches, item_code) - reserved
    if quantity <= 0:
        return False, "Quantity must be greater than zero."
    if quantity > available + 1e-9:
        return False, f"Only {max(0, available):g} unexpired units are available."

    unit_price = float(item["Selling Price"])
    unit_cost = float(item["Cost Price"])
    shown_name = display_name or str(item["Item Name"])
    line_name = line_suffix or f"{shown_name} (x{quantity:g} packs)"
    existing = next(
        (
            line for line in st.session_state.cart
            if line.get("Product Code") == str(item_code)
            and line["Item Name"] == line_name
        ),
        None,
    )
    if existing:
        existing["Qty Units"] += quantity
        existing["Price"] += unit_price * quantity
        existing["Cost"] += unit_cost * quantity
        existing["Total"] += unit_price * quantity
    else:
        st.session_state.cart.append({
            "Item Name": line_name,
            "Base Name": str(item["Item Name"]),
            "Product Code": str(item_code),
            "Qty Units": quantity,
            "Price": unit_price * quantity,
            "Cost": unit_cost * quantity,
            "Total": unit_price * quantity,
        })
    return True, f"Added {line_name} to the cart."
df_sales = load_data(
    SALES_FILE,
    [
        "Sale ID",
        "Date Time",
        "Item Name",
        "Qty",
        "Revenue",
        "Cost",
        "Net Profit",
        "Cashier",
    ],
    numeric_cols=["Qty", "Revenue", "Cost", "Net Profit"],
)
df_udhaar = load_data(
    UDHAAR_FILE,
    [
        "Khata ID",
        "Customer",
        "Phone",
        "Details",
        "Total Bill",
        "Paid",
        "Balance Due",
        "Status",
    ],
    numeric_cols=["Total Bill", "Paid", "Balance Due"],
)
df_sup = load_data(
    SUP_FILE,
    [
        "Supplier ID",
        "Supplier Name",
        "Phone",
        "Invoice",
        "Total Bill",
        "Paid",
        "Balance Due",
        "Status",
    ],
    numeric_cols=["Total Bill", "Paid", "Balance Due"],
)
df_exp = load_data(
    EXP_FILE,
    ["Expense ID", "Date", "Category", "Description", "Amount"],
    numeric_cols=["Amount"],
)

if "cart" not in st.session_state:
    st.session_state.cart = []

st.title(st.session_state.store_name)
st.caption(
    f"Medical store operations · Signed in as {st.session_state.user_email}"
)

with st.sidebar:
    st.subheader("Workspace")
    st.caption(st.session_state.store_name)
    st.badge(st.session_state.user_role, color="blue")
    search_query = st.text_input(
        "Search workspace",
        type="search",
        placeholder="Products, sales, customers, suppliers",
        help="Search records in this store.",
    )

    if search_query.strip():
        search_results = []
        search_sources = [
            (
                "Product",
                df_inv,
                ["Item Name", "Generic Name", "Item Code", "Barcode"],
                "Item Name",
                "Item Code",
            ),
            ("Sale", df_sales, ["Sale ID", "Item Name"], "Sale ID", "Date Time"),
            ("Customer", df_udhaar, ["Customer", "Phone"], "Customer", "Phone"),
            ("Supplier", df_sup, ["Supplier Name", "Phone"], "Supplier Name", "Supplier ID"),
        ]
        for record_type, records, search_columns, title_column, reference_column in search_sources:
            matched = pd.Series(False, index=records.index)
            for column in search_columns:
                if column in records.columns:
                    matched |= records[column].astype("string").str.contains(
                        search_query.strip(), case=False, na=False, regex=False
                    )
            for _, record in records.loc[matched].head(4).iterrows():
                reference = record.get(reference_column, "")
                search_results.append({
                    "Type": record_type,
                    "Record": str(record.get(title_column, "")),
                    "Reference": str(reference),
                })

        if search_results:
            st.dataframe(
                pd.DataFrame(search_results[:12]),
                hide_index=True,
            )
        else:
            st.caption("No matching records.")

    if st.button("Log out", icon=":material/logout:", width="stretch"):
        st.session_state.logged_in = False
        st.rerun()

tabs = st.tabs([
    ":material/dashboard: Dashboard",
    ":material/point_of_sale: Point of sale",
    ":material/inventory_2: Inventory",
    ":material/group: Customer ledger",
    ":material/local_shipping: Suppliers",
    ":material/payments: Expenses",
    ":material/settings: Store settings",
])

# ================= 1. DASHBOARD =================
with tabs[0]:
    st.header("Business overview", icon=":material/analytics:")
    st.caption("A live view of sales, stock health, and outstanding balances.")

    parsed_sales = df_sales.copy()
    parsed_sales["ParsedDateTime"] = pd.to_datetime(
        parsed_sales["Date Time"], errors="coerce"
    )
    valid_sales = parsed_sales.dropna(subset=["ParsedDateTime"])
    today = pd.Timestamp(date.today())
    today_sales = valid_sales[
        valid_sales["ParsedDateTime"].dt.date == date.today()
    ]
    today_revenue = float(today_sales["Revenue"].sum())
    today_profit = float(today_sales["Net Profit"].sum())
    inventory_value = float(df_inv["Inventory Value"].sum())
    low_stock_items = df_inv[df_inv["Stock"] <= df_inv["Min Stock"]].copy()

    inventory_expiry = df_batch_view[df_batch_view["Stock"] > 0].copy()
    inventory_expiry["ParsedExpiry"] = pd.to_datetime(
        inventory_expiry["Expiry Date"], errors="coerce"
    )
    expiring_soon = inventory_expiry[
        inventory_expiry["ParsedExpiry"].between(
            today, today + pd.Timedelta(days=90), inclusive="both"
        )
    ].copy()
    expired_items = inventory_expiry[
        inventory_expiry["ParsedExpiry"] < today
    ].copy()

    receivables = float(
        df_udhaar.loc[df_udhaar["Status"] == "Pending", "Balance Due"]
        .clip(lower=0)
        .sum()
    )
    payables = float(
        df_sup.loc[df_sup["Status"] == "Pending", "Balance Due"]
        .clip(lower=0)
        .sum()
    )
    financial_roles = {"Store Owner", "Admin", "Manager", "Accountant", "Super Admin"}
    can_view_financials = st.session_state.user_role in financial_roles

    with st.container(horizontal=True):
        st.metric("Today's sales", f"PKR {today_revenue:,.2f}", border=True)
        if can_view_financials:
            st.metric("Today's profit", f"PKR {today_profit:,.2f}", border=True)
            st.metric("Inventory at cost", f"PKR {inventory_value:,.2f}", border=True)
        st.metric("Low-stock items", f"{len(low_stock_items):,}", border=True)
        st.metric("Expiring within 90 days", f"{len(expiring_soon):,}", border=True)

    if can_view_financials:
        with st.container(horizontal=True):
            st.metric("Customer receivables", f"PKR {receivables:,.2f}", border=True)
            st.metric("Supplier payables", f"PKR {payables:,.2f}", border=True)

    trend_period = st.segmented_control(
        "Sales trend",
        ["7 days", "30 days", "90 days"],
        default="30 days",
        key="dashboard_trend_period",
    )
    trend_days = int(trend_period.split()[0])
    trend_start = today - pd.Timedelta(days=trend_days - 1)
    trend_sales = valid_sales[
        valid_sales["ParsedDateTime"].between(
            trend_start, today + pd.Timedelta(days=1), inclusive="left"
        )
    ]
    trend_col, category_col = st.columns([1.7, 1])
    with trend_col:
        with st.container(border=True):
            st.subheader("Sales and profit trend")
            if trend_sales.empty:
                st.info("No sales recorded in this period yet.")
            else:
                daily_trend = (
                    trend_sales.assign(
                        Date=trend_sales["ParsedDateTime"].dt.normalize()
                    )
                    .groupby("Date", as_index=False)
                    .agg(
                        Sales=("Revenue", "sum"),
                        Profit=("Net Profit", "sum"),
                    )
                    .set_index("Date")
                    .reindex(
                        pd.date_range(trend_start, today, freq="D"),
                        fill_value=0,
                    )
                    .rename_axis("Date")
                    .reset_index()
                )
                st.area_chart(
                    daily_trend,
                    x="Date",
                    y=["Sales", "Profit"],
                    height=280,
                )

    with category_col:
        with st.container(border=True):
            st.subheader("Inventory value by category")
            if df_inv.empty:
                st.info("Add products to see inventory value by category.")
            else:
                category_value = (
                    df_inv.assign(
                        **{"Inventory value": df_inv["Inventory Value"]}
                    )
                    .groupby("Category", as_index=False)["Inventory value"]
                    .sum()
                    .sort_values("Inventory value", ascending=False)
                )
                st.bar_chart(
                    category_value,
                    x="Category",
                    y="Inventory value",
                    height=280,
                )

    alert_col, expiry_col = st.columns(2)
    with alert_col:
        with st.container(border=True):
            st.subheader("Low-stock alerts")
            if low_stock_items.empty:
                st.success("All products are above their reorder levels.")
            else:
                st.dataframe(
                    low_stock_items[
                        ["Item Code", "Item Name", "Stock", "Min Stock"]
                    ].sort_values("Stock"),
                    hide_index=True,
                )
                st.caption("Review these products in Inventory to plan replenishment.")

    with expiry_col:
        with st.container(border=True):
            st.subheader("Expiry watch")
            expiry_alerts = pd.concat(
                [
                    expired_items.assign(Status="Expired"),
                    expiring_soon.assign(Status="Expiring soon"),
                ],
                ignore_index=True,
            ).drop_duplicates(subset=["Item Code", "Batch No"])
            if expiry_alerts.empty:
                st.success("No expired or near-expiry products found.")
            else:
                expiry_alerts["Expiry Date"] = expiry_alerts["ParsedExpiry"].dt.strftime(
                    "%Y-%m-%d"
                )
                st.dataframe(
                    expiry_alerts[
                        ["Item Code", "Item Name", "Batch No", "Expiry Date", "Status"]
                    ].sort_values("Expiry Date"),
                    hide_index=True,
                )
                st.caption("Review these batches in Inventory before dispensing.")

    with st.container(border=True):
        st.subheader("Recent sales")
        if valid_sales.empty:
            st.info("Sales will appear here after the first checkout.")
        else:
            recent_sales = (
                valid_sales.sort_values("ParsedDateTime", ascending=False)
                .head(8)
                .copy()
            )
            recent_sales["Revenue"] = recent_sales["Revenue"].map(
                lambda amount: f"PKR {amount:,.2f}"
            )
            st.dataframe(
                recent_sales[
                    ["Sale ID", "Date Time", "Item Name", "Qty", "Revenue", "Cashier"]
                ],
                hide_index=True,
            )

    st.subheader("Sales records")
    col_f1, col_f2, col_f3 = st.columns(3)
    filter_type = col_f1.selectbox(
        "Filter records",
        ["All time", "Weekly", "Monthly", "Custom hours"],
        key="dash_filter_period",
    )

    filtered_sales = parsed_sales.copy()
    if filter_type == "Weekly":
        filtered_sales = filtered_sales[
            filtered_sales["ParsedDateTime"] >= today - pd.Timedelta(days=7)
        ]
    elif filter_type == "Monthly":
        filtered_sales = filtered_sales[
            filtered_sales["ParsedDateTime"] >= today - pd.Timedelta(days=30)
        ]
    elif filter_type == "Custom hours":
        c_h1, c_h2 = col_f2.columns(2)
        start_h = c_h1.number_input("Start hour", 0, 23, 9, key="sh")
        end_h = c_h2.number_input("End hour", 0, 23, 18, key="eh")
        filtered_sales = filtered_sales[
            filtered_sales["ParsedDateTime"].dt.hour.between(start_h, end_h)
        ]

    total_revenue = filtered_sales["Revenue"].sum()
    gross_profit = filtered_sales["Net Profit"].sum()
    total_items_sold = filtered_sales["Qty"].sum()
    if can_view_financials:
        st.caption(
            f"Selected period · PKR {total_revenue:,.2f} sales · "
            f"PKR {gross_profit:,.2f} profit · {total_items_sold:,.0f} units"
        )
    else:
        st.caption(
            f"Selected period · PKR {total_revenue:,.2f} sales · "
            f"{total_items_sold:,.0f} units"
        )
    if filtered_sales.empty:
        st.info("No sales records match this period.")
    else:
        sales_table = filtered_sales.drop(
            columns=["ParsedDateTime"], errors="ignore"
        )
        if not can_view_financials:
            sales_table = sales_table.drop(
                columns=["Cost", "Net Profit"], errors="ignore"
            )
        st.dataframe(sales_table, hide_index=True)

    if not df_sales.empty and can_view_financials:
        with st.expander("Edit or delete a sale record", icon=":material/edit:"):
            edit_s_id = st.selectbox(
                "Select sale ID to modify",
                df_sales["Sale ID"].tolist(),
                key="edit_sale_select",
            )
            s_row = df_sales[df_sales["Sale ID"] == edit_s_id].iloc[0]
            with st.form("edit_sale_form"):
                new_s_qty = st.number_input(
                    "Update quantity", min_value=1, value=int(s_row["Qty"])
                )
                up_sale_btn = st.form_submit_button("Update sale record")
                if up_sale_btn:
                    rev_per_unit = s_row["Revenue"] / s_row["Qty"]
                    cost_per_unit = s_row["Cost"] / s_row["Qty"]
                    new_rev = rev_per_unit * new_s_qty
                    new_cost = cost_per_unit * new_s_qty
                    new_prof = new_rev - new_cost

                    df_sales.loc[df_sales["Sale ID"] == edit_s_id, "Qty"] = (
                        new_s_qty
                    )
                    df_sales.loc[df_sales["Sale ID"] == edit_s_id, "Revenue"] = (
                        new_rev
                    )
                    df_sales.loc[df_sales["Sale ID"] == edit_s_id, "Cost"] = (
                        new_cost
                    )
                    df_sales.loc[
                        df_sales["Sale ID"] == edit_s_id, "Net Profit"
                    ] = new_prof
                    df_sales.to_csv(SALES_FILE, index=False)
                    st.success("Sale record updated successfully.")
                    st.rerun()

            if st.button("Delete this sale record", key="del_sale_btn", icon=":material/delete:"):
                df_sales = df_sales[df_sales["Sale ID"] != edit_s_id]
                df_sales.to_csv(SALES_FILE, index=False)
                st.success("Sale record deleted successfully.")
                st.rerun()
    elif df_sales.empty:
        st.info("No sales records available.")

# ================= 2. ADVANCED POS CART & CHECKOUT (With Tablet/Strip Splitting & Discounts) =================
with tabs[1]:
    st.subheader("🛒 Advanced Point of Sale (POS) & Cart Billing")

    if df_inv.empty:
        st.warning(
            "Inventory is empty. Please add items in the 'Inventory & Alerts'"
            " tab first."
        )
    else:
        col_cart1, col_cart2 = st.columns([1.2, 1])

        with col_cart1:
            st.markdown("#### Scan a product barcode")
            with st.form("pos_barcode_form"):
                scanned_barcode = st.text_input(
                    "Barcode",
                    key="pos_barcode",
                    help="Scan or type a product barcode, then submit.",
                )
                scanned_quantity = st.number_input(
                    "Quantity (packs)",
                    min_value=1,
                    value=1,
                    step=1,
                    key="pos_barcode_quantity",
                )
                barcode_submit = st.form_submit_button(
                    "Add scanned product",
                    icon=":material/barcode_scanner:",
                )
                if barcode_submit:
                    barcode_matches = df_products[
                        df_products["Barcode"].fillna("").astype(str).str.strip().str.casefold()
                        == scanned_barcode.strip().casefold()
                    ]
                    if not scanned_barcode.strip():
                        st.error("Scan or enter a barcode first.")
                    elif len(barcode_matches) != 1:
                        st.error(
                            "No unique product matches this barcode. Check the product barcode in Inventory."
                        )
                    else:
                        success, message = queue_cart_item(
                            barcode_matches.iloc[0]["Item Code"],
                            scanned_quantity,
                        )
                        if success:
                            st.success(message)
                            st.rerun()
                        else:
                            st.error(message)

            st.markdown("#### Add items to cart")
            with st.form("add_to_cart_form"):
                product_options = {
                    f"{row['Item Name']} · {row['Item Code']}": str(row["Item Code"])
                    for _, row in df_inv.iterrows()
                }
                selected_product = st.selectbox(
                    "Select product",
                    list(product_options),
                    key="pos_item_select",
                )
                selected_code = product_options[selected_product]
                item_row = df_inv[df_inv["Item Code"].astype(str) == selected_code].iloc[0]
                available_stock = sellable_stock(df_batches, selected_code)
                reserved_stock = sum(
                    float(line["Qty Units"])
                    for line in st.session_state.cart
                    if str(line.get("Product Code", "")) == selected_code
                )
                available_to_add = max(0, available_stock - reserved_stock)
                st.caption(
                    f"Available unexpired stock: {available_to_add:g} packs"
                )

                sale_type = st.segmented_control(
                    "Sale format",
                    ["Full pack", "Loose tablets"],
                    default="Full pack",
                    key="pos_sale_type",
                )
                cart_qty = st.number_input(
                    "Quantity (packs)", min_value=1, value=1, step=1, key="pos_qty"
                )
                pack_size_value = pd.to_numeric(
                    item_row["Pack Size"], errors="coerce"
                )
                pack_size = (
                    max(1, int(pack_size_value))
                    if pd.notna(pack_size_value)
                    else 10
                )
                if sale_type == "Loose tablets":
                    tablets_bought = st.number_input(
                        "Number of tablets",
                        min_value=1,
                        value=1,
                        key="loose_tabs_count",
                    )
                else:
                    tablets_bought = 0

                add_to_cart_btn = st.form_submit_button(
                    "Add to cart",
                    icon=":material/add_shopping_cart:",
                )

                if add_to_cart_btn:
                    if available_to_add <= 0:
                        st.error("No unreserved, unexpired stock is available for this product.")
                    elif sale_type == "Loose tablets":
                        effective_qty_units = tablets_bought / pack_size
                        success, message = queue_cart_item(
                            selected_code,
                            effective_qty_units,
                            line_suffix=(
                                f"{item_row['Item Name']} ({tablets_bought} tablets)"
                            ),
                        )
                    else:
                        success, message = queue_cart_item(
                            selected_code,
                            cart_qty,
                        )
                    if available_to_add > 0:
                        if success:
                            st.success(message)
                            st.rerun()
                        else:
                            st.error(message)

        with col_cart2:
            st.markdown("#### Current Bill Cart")
            if st.session_state.cart:
                cart_df = pd.DataFrame(st.session_state.cart)
                st.dataframe(cart_df[["Item Name", "Qty Units", "Total"]])
                subtotal_amount = cart_df["Total"].sum()
                
                # Customer Discount Selection (10%, 12%, 15%, etc.)
                discount_pct = st.selectbox("Apply Customer Discount (%)", [0, 5, 10, 12, 15, 20], key="cust_disc_pct")
                discount_amount = (subtotal_amount * discount_pct) / 100
                grand_total = subtotal_amount - discount_amount

                st.markdown(f"Subtotal: PKR {subtotal_amount:,.2f}")
                st.markdown(f"Discount ({discount_pct}%): - PKR {discount_amount:,.2f}")
                st.markdown(
                    f"### Grand Total: PKR {grand_total:,.2f}",
                    unsafe_allow_html=True,
                )

                if st.button("🗑️ Clear Cart", key="clear_cart_btn"):
                    st.session_state.cart = []
                    st.rerun()
            else:
                st.info("Cart is currently empty.")

        if st.session_state.cart:
            st.markdown("---")
            st.markdown("#### Checkout & Customer Details")
            with st.form("checkout_form"):
                c_name = st.text_input(
                    "Customer Name", value="Walk-in Customer", key="chk_name"
                )
                c_phone = st.text_input(
                    "Customer Phone", value="03316368566", key="chk_phone"
                )
                sale_datetime = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                checkout_btn = st.form_submit_button(
                    "✅ Complete Checkout & Generate Receipt"
                )

                if checkout_btn:
                    s_id = f"S{len(df_sales)+1:03d}"
                    cart_df = pd.DataFrame(st.session_state.cart)
                    batches_after_sale, total_cost, sale_movements, stock_error = (
                        prepare_fefo_sale(
                            cart_df,
                            df_batches,
                            df_products,
                            s_id,
                            sale_datetime,
                            st.session_state.user_email,
                        )
                    )

                    if stock_error:
                        st.error(stock_error)
                    else:
                        sub_rev = cart_df["Total"].sum()
                        disc_applied = (sub_rev * discount_pct) / 100
                        total_rev = sub_rev - disc_applied
                        total_prof = total_rev - total_cost
                        total_qty_items = cart_df["Qty Units"].sum()
                        item_summary_str = ", ".join(
                            f"{row['Item Name']}" for _, row in cart_df.iterrows()
                        )

                        new_sale = pd.DataFrame(
                            [[
                                s_id,
                                sale_datetime,
                                item_summary_str,
                                total_qty_items,
                                total_rev,
                                total_cost,
                                total_prof,
                                st.session_state.user_email,
                            ]],
                            columns=df_sales.columns,
                        )
                        batches_after_sale.to_csv(BATCHES_FILE, index=False)
                        add_stock_movements(sale_movements)
                        df_sales = pd.concat([df_sales, new_sale], ignore_index=True)
                        df_sales.to_csv(SALES_FILE, index=False)
                        df_batches = batches_after_sale
                        df_inv = inventory_summary(df_products, df_batches)
                        df_batch_view = df_batches.merge(
                            df_products[["Item Code", "Item Name", "Generic Name"]],
                            on="Item Code",
                            how="left",
                        )

                        st.success("Checkout complete. FEFO batches were updated.")

                        receipt_items_html = "".join([
                            f"<tr><td>{r['Item Name']}</td><td>PKR {r['Total']:,.2f}</td></tr>"
                            for _, r in cart_df.iterrows()
                        ])
                        receipt_html = f"""
                        <div style='background-color: #1e293b; color: #ffffff; padding: 25px; border-radius: 10px; border: 2px dashed #3b82f6; width: 460px; margin: auto; box-shadow: 0 4px 10px rgba(0,0,0,0.5);'>
                            <h2 style='text-align: center; margin: 0; color: #60a5fa;'>{st.session_state.store_name.upper()}</h2>
                            <p style='text-align: center; font-size: 12px; margin: 0; color: #94a3b8;'>Proprietor: Syed Hashir Ali | Ph: {c_phone}</p>
                            <hr style='border: 1px solid #334155;'>
                            <p><b>Receipt ID:</b> {s_id} <br><b>Date:</b> {sale_datetime}</p>
                            <p><b>Customer:</b> {c_name} ({c_phone})</p>
                            <table style='width:100%; font-size: 13px; border-collapse: collapse; color: #ffffff;'>
                                <tr style='border-bottom: 1px solid #334155;'><th>Item & Qty</th><th>Total</th></tr>
                                {receipt_items_html}
                            </table>
                            <hr style='border: 1px solid #334155;'>
                            <p>Subtotal: PKR {sub_rev:,.2f}</p>
                            <p>Discount Applied: {discount_pct}% (-PKR {disc_applied:,.2f})</p>
                            <p style='font-size: 16px; text-align: right;'><b>Grand Total: PKR {total_rev:,.2f}</b></p>
                            <p style='text-align: center; font-size: 13px; color: #60a5fa;'><b>Thank you for your business!</b></p>
                        </div>
                        """
                        st.markdown(receipt_html, unsafe_allow_html=True)

                        whatsapp_text = f"*{st.session_state.store_name.upper()} INVOICE*\nReceipt ID: {s_id}\nCustomer: {c_name}\nDiscount: {discount_pct}%\nGrand Total: PKR {total_rev:,.2f}\nThank you for shopping with us!"
                        encoded_wa = urllib.parse.quote(whatsapp_text)
                        wa_link = f"https://wa.me/{c_phone}?text={encoded_wa}"

                        st.markdown(
                            f'<br><div style="text-align: center;"><a'
                            f' href="{wa_link}" target="_blank"><button'
                            " style=\"background-color:#2563eb; color:white;"
                            " padding:12px 24px; border:none; border-radius:6px;"
                            " font-weight:bold; font-size:16px; cursor:"
                            ' pointer;">📲 Send Invoice via WhatsApp</button></a></div>',
                            unsafe_allow_html=True,
                        )

                        st.session_state.cart = []

# ================= 3. INVENTORY & ALERTS =================
with tabs[2]:
    st.subheader("Inventory management", icon=":material/inventory_2:")
    st.caption(
        "Manage product details, trace expiry by batch, and review every stock movement."
    )

    (
        inv_catalog_tab,
        inv_batches_tab,
        inv_alerts_tab,
        inv_add_tab,
        inv_receive_tab,
        inv_adjust_tab,
        inv_edit_tab,
        inv_history_tab,
    ) = st.tabs([
        "Product catalog",
        "Batch register",
        "Stock and expiry alerts",
        "Add product",
        "Receive stock",
        "Adjust stock",
        "Edit / remove product",
        "Movement history",
    ])

    with inv_catalog_tab:
        if df_inv.empty:
            st.info("No products yet. Add a product to start building the catalog.")
        else:
            st.dataframe(
                df_inv[
                    [
                        "Item Code",
                        "Item Name",
                        "Generic Name",
                        "Category",
                        "Manufacturer",
                        "Barcode",
                        "Unit",
                        "Pack Size",
                        "Stock",
                        "Min Stock",
                        "Cost Price",
                        "Inventory Value",
                        "Selling Price",
                        "Tax Rate",
                        "Location",
                    ]
                ],
                hide_index=True,
                column_config={
                    "Stock": st.column_config.NumberColumn("Stock", format="%.2f"),
                    "Cost Price": st.column_config.NumberColumn(
                        "Purchase price", format="PKR %.2f"
                    ),
                    "Inventory Value": st.column_config.NumberColumn(
                        "Batch value", format="PKR %.2f"
                    ),
                    "Selling Price": st.column_config.NumberColumn(
                        "Sale price", format="PKR %.2f"
                    ),
                    "Tax Rate": st.column_config.NumberColumn(
                        "Tax rate", format="%.2f%%"
                    ),
                },
            )
            st.caption(
                f"{len(df_inv):,} products · "
                f"{int((df_inv['Stock'] <= df_inv['Min Stock']).sum()):,} at or below reorder level"
            )

    with inv_batches_tab:
        if df_batch_view.empty:
            st.info("No batches have been received.")
        else:
            batch_table = df_batch_view.copy()
            batch_table["Expiry Date"] = pd.to_datetime(
                batch_table["Expiry Date"], errors="coerce"
            ).dt.strftime("%Y-%m-%d")
            st.dataframe(
                batch_table[
                    [
                        "Batch ID",
                        "Item Code",
                        "Item Name",
                        "Batch No",
                        "Expiry Date",
                        "Stock",
                        "Cost Price",
                        "Supplier",
                        "Received Date",
                    ]
                ].sort_values(["Expiry Date", "Item Name"], na_position="last"),
                hide_index=True,
                column_config={
                    "Stock": st.column_config.NumberColumn("Stock", format="%.2f"),
                    "Cost Price": st.column_config.NumberColumn(
                        "Batch purchase price", format="PKR %.2f"
                    ),
                },
            )

    with inv_alerts_tab:
        if df_inv.empty:
            st.info("Add products to see stock and expiry alerts.")
        else:
            low_stock = df_inv[df_inv["Stock"] <= df_inv["Min Stock"]].copy()
            if low_stock.empty:
                st.success("All products are above their reorder levels.")
            else:
                st.warning(f"{len(low_stock)} products are at or below reorder level.")
                st.dataframe(
                    low_stock[
                        ["Item Code", "Item Name", "Stock", "Min Stock", "Location"]
                    ].sort_values("Stock"),
                    hide_index=True,
                )

            alert_batches = df_batch_view[df_batch_view["Stock"] > 0].copy()
            alert_batches["Parsed Expiry"] = pd.to_datetime(
                alert_batches["Expiry Date"], errors="coerce"
            )
            alert_batches = alert_batches[
                alert_batches["Parsed Expiry"].isna()
                | (
                    alert_batches["Parsed Expiry"]
                    <= pd.Timestamp(date.today()) + pd.Timedelta(days=90)
                )
            ]
            if alert_batches.empty:
                st.success("No expired or near-expiry batches were found.")
            else:
                alert_batches["Expiry Status"] = alert_batches["Parsed Expiry"].apply(
                    lambda expiry: (
                        "Expiry date missing"
                        if pd.isna(expiry)
                        else "Expired"
                        if expiry.date() < date.today()
                        else "Expiring soon"
                    )
                )
                alert_batches["Expiry Date"] = alert_batches[
                    "Parsed Expiry"
                ].dt.strftime("%Y-%m-%d")
                st.warning(f"{len(alert_batches)} batches need expiry review.")
                st.dataframe(
                    alert_batches[
                        [
                            "Item Code",
                            "Item Name",
                            "Batch No",
                            "Expiry Date",
                            "Expiry Status",
                            "Stock",
                        ]
                    ].sort_values("Expiry Date", na_position="first"),
                    hide_index=True,
                )

    with inv_add_tab:
        with st.form("add_inv_form"):
            st.markdown("Product details")
            product_col1, product_col2, product_col3 = st.columns(3)
            icode = product_col1.text_input("Item code", key="add_inv_code")
            iname = product_col2.text_input("Product name", key="add_inv_name")
            generic_name = product_col3.text_input(
                "Generic name", key="add_inv_generic"
            )

            product_col4, product_col5, product_col6 = st.columns(3)
            category = product_col4.text_input(
                "Category", key="add_inv_category"
            )
            manufacturer = product_col5.text_input(
                "Manufacturer", key="add_inv_manufacturer"
            )
            barcode = product_col6.text_input(
                "Barcode", key="add_inv_barcode"
            )

            product_col7, product_col8, product_col9 = st.columns(3)
            unit = product_col7.selectbox(
                "Sale unit",
                ["Tablet", "Strip", "Box", "Bottle", "Syrup (ml)", "Pack", "Other"],
                key="add_inv_unit",
            )
            pack_size = product_col8.number_input(
                "Units per pack",
                min_value=1,
                value=10,
                key="add_inv_pack_size",
            )
            location = product_col9.text_input(
                "Shelf / rack location", key="add_inv_location"
            )

            product_col10, product_col11, product_col12, product_col13 = st.columns(4)
            cost_price = product_col10.number_input(
                "Purchase price (PKR)",
                min_value=0.0,
                value=0.0,
                key="add_inv_cost",
            )
            selling_price = product_col11.number_input(
                "Sale price (PKR)",
                min_value=0.0,
                value=0.0,
                key="add_inv_sale",
            )
            tax_rate = product_col12.number_input(
                "Tax rate (%)",
                min_value=0.0,
                max_value=100.0,
                value=0.0,
                key="add_inv_tax",
            )
            min_stock = product_col13.number_input(
                "Reorder level",
                min_value=0.0,
                value=0.0,
                key="add_inv_min",
            )

            st.markdown("Opening batch (optional)")
            batch_col1, batch_col2, batch_col3 = st.columns(3)
            initial_batch = batch_col1.text_input(
                "Batch number", key="add_inv_batch"
            )
            initial_expiry = batch_col2.date_input(
                "Expiry date",
                value=None,
                key="add_inv_expiry",
            )
            initial_stock = batch_col3.number_input(
                "Opening stock (packs)",
                min_value=0.0,
                value=0.0,
                key="add_inv_stock",
            )

            if st.form_submit_button("Save product", icon=":material/save:"):
                normalized_code = icode.strip()
                normalized_barcode = barcode.strip()
                existing_barcodes = (
                    df_products["Barcode"].fillna("").astype(str).str.strip()
                )
                if not normalized_code or not iname.strip():
                    st.error("Item code and product name are required.")
                elif normalized_code in df_products["Item Code"].astype(str).values:
                    st.error("That item code is already in use.")
                elif (
                    normalized_barcode
                    and normalized_barcode.casefold()
                    in existing_barcodes.str.casefold().values
                ):
                    st.error("That barcode is already assigned to another product.")
                elif initial_stock > 0 and (
                    not initial_batch.strip() or initial_expiry is None
                ):
                    st.error(
                        "An opening batch number and expiry date are required when opening stock is entered."
                    )
                elif (
                    initial_stock > 0
                    and initial_expiry < date.today()
                ):
                    st.error("Opening stock cannot be assigned an expired batch.")
                else:
                    new_product = {
                        "Item Code": normalized_code,
                        "Item Name": iname.strip(),
                        "Generic Name": generic_name.strip(),
                        "Category": category.strip(),
                        "Manufacturer": manufacturer.strip(),
                        "Barcode": normalized_barcode,
                        "Unit": unit,
                        "Pack Size": pack_size,
                        "Cost Price": cost_price,
                        "Selling Price": selling_price,
                        "Tax Rate": tax_rate,
                        "Min Stock": min_stock,
                        "Location": location.strip(),
                    }
                    df_products = pd.concat(
                        [
                            df_products,
                            pd.DataFrame([new_product], columns=PRODUCT_COLUMNS),
                        ],
                        ignore_index=True,
                    )
                    df_products.to_csv(PRODUCTS_FILE, index=False)
                    if initial_stock > 0:
                        batch_id = f"{normalized_code}-{initial_batch.strip()}-001"
                        df_batches = pd.concat(
                            [
                                df_batches,
                                pd.DataFrame([{
                                    "Batch ID": batch_id,
                                    "Item Code": normalized_code,
                                    "Batch No": initial_batch.strip(),
                                    "Expiry Date": initial_expiry.isoformat(),
                                    "Stock": initial_stock,
                                    "Cost Price": cost_price,
                                    "Supplier": "",
                                    "Received Date": date.today().isoformat(),
                                }], columns=BATCH_COLUMNS),
                            ],
                            ignore_index=True,
                        )
                        df_batches.to_csv(BATCHES_FILE, index=False)
                        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        add_stock_movements([{
                            "Movement ID": f"{batch_id}-OPEN",
                            "Timestamp": timestamp,
                            "User": st.session_state.user_email,
                            "Movement Type": "Opening stock",
                            "Item Code": normalized_code,
                            "Item Name": iname.strip(),
                            "Batch No": initial_batch.strip(),
                            "Quantity Change": initial_stock,
                            "Previous Stock": 0,
                            "New Stock": initial_stock,
                            "Reason": "Initial inventory entry",
                            "Reference": batch_id,
                        }])
                    st.success("Product saved to the catalog.")
                    st.rerun()

    with inv_receive_tab:
        if df_products.empty:
            st.info("Add a product before receiving stock.")
        else:
            with st.form("receive_stock_form"):
                receive_product = st.selectbox(
                    "Product",
                    df_products["Item Code"].astype(str).tolist(),
                    format_func=lambda code: (
                        f"{df_products.loc[df_products['Item Code'].astype(str) == code, 'Item Name'].iloc[0]} · {code}"
                    ),
                    key="receive_product",
                )
                receive_col1, receive_col2, receive_col3 = st.columns(3)
                receive_batch = receive_col1.text_input(
                    "Batch number", key="receive_batch"
                )
                receive_expiry = receive_col2.date_input(
                    "Expiry date", value=None, key="receive_expiry"
                )
                receive_quantity = receive_col3.number_input(
                    "Quantity received (packs)",
                    min_value=0.01,
                    value=1.0,
                    key="receive_quantity",
                )
                receive_col4, receive_col5 = st.columns(2)
                receive_cost = receive_col4.number_input(
                    "Batch purchase price (PKR)",
                    min_value=0.0,
                    value=0.0,
                    key="receive_cost",
                )
                receive_supplier = receive_col5.selectbox(
                    "Supplier",
                    [""] + df_sup["Supplier Name"].dropna().astype(str).tolist(),
                    key="receive_supplier",
                )
                if st.form_submit_button(
                    "Record stock receipt",
                    icon=":material/add_box:",
                ):
                    if not receive_batch.strip() or receive_expiry is None:
                        st.error("Batch number and expiry date are required.")
                    elif receive_expiry < date.today():
                        st.error("Expired batches cannot be received into sellable stock.")
                    else:
                        product = df_products[
                            df_products["Item Code"].astype(str) == receive_product
                        ].iloc[0]
                        batch_number = sum(
                            df_batches["Item Code"].astype(str) == receive_product
                        ) + 1
                        batch_id = (
                            f"{receive_product}-{receive_batch.strip()}-"
                            f"{batch_number:03d}"
                        )
                        df_batches = pd.concat(
                            [
                                df_batches,
                                pd.DataFrame([{
                                    "Batch ID": batch_id,
                                    "Item Code": receive_product,
                                    "Batch No": receive_batch.strip(),
                                    "Expiry Date": receive_expiry.isoformat(),
                                    "Stock": receive_quantity,
                                    "Cost Price": receive_cost,
                                    "Supplier": receive_supplier,
                                    "Received Date": date.today().isoformat(),
                                }], columns=BATCH_COLUMNS),
                            ],
                            ignore_index=True,
                        )
                        df_batches.to_csv(BATCHES_FILE, index=False)
                        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        add_stock_movements([{
                            "Movement ID": f"{batch_id}-RCV",
                            "Timestamp": timestamp,
                            "User": st.session_state.user_email,
                            "Movement Type": "Stock receipt",
                            "Item Code": receive_product,
                            "Item Name": product["Item Name"],
                            "Batch No": receive_batch.strip(),
                            "Quantity Change": receive_quantity,
                            "Previous Stock": 0,
                            "New Stock": receive_quantity,
                            "Reason": "Supplier stock-in",
                            "Reference": batch_id,
                        }])
                        st.success("Stock receipt recorded against the new batch.")
                        st.rerun()

    with inv_adjust_tab:
        if df_batches.empty:
            st.info("There are no batches to adjust.")
        else:
            batch_labels = {
                str(batch["Batch ID"]): (
                    f"{batch['Item Name']} · batch {batch['Batch No']} "
                    f"· {float(batch['Stock']):g} packs"
                )
                for _, batch in df_batch_view.iterrows()
            }
            with st.form("stock_adjustment_form"):
                selected_batch_id = st.selectbox(
                    "Batch",
                    df_batches["Batch ID"].astype(str).tolist(),
                    format_func=lambda batch_id: batch_labels[batch_id],
                    key="adjust_batch",
                )
                adjust_col1, adjust_col2 = st.columns(2)
                adjustment_direction = adjust_col1.selectbox(
                    "Adjustment",
                    ["Remove stock", "Add stock"],
                    key="adjust_direction",
                )
                adjustment_reason = adjust_col2.selectbox(
                    "Reason code",
                    [
                        "Damage",
                        "Expiry write-off",
                        "Manual stock correction",
                        "Supplier return",
                        "Other",
                    ],
                    key="adjust_reason",
                )
                adjustment_quantity = st.number_input(
                    "Quantity (packs)",
                    min_value=0.01,
                    value=1.0,
                    key="adjust_quantity",
                )
                adjustment_notes = st.text_input(
                    "Notes",
                    help="Add context for the stock audit trail.",
                    key="adjust_notes",
                )
                if st.form_submit_button(
                    "Save stock adjustment",
                    icon=":material/edit_note:",
                ):
                    batch_index = df_batches.index[
                        df_batches["Batch ID"].astype(str) == selected_batch_id
                    ][0]
                    previous_stock = float(df_batches.at[batch_index, "Stock"])
                    change = (
                        adjustment_quantity
                        if adjustment_direction == "Add stock"
                        else -adjustment_quantity
                    )
                    new_stock = previous_stock + change
                    if new_stock < -1e-9:
                        st.error(
                            f"Adjustment exceeds available batch stock ({previous_stock:g} packs)."
                        )
                    else:
                        df_batches.at[batch_index, "Stock"] = max(0.0, new_stock)
                        df_batches.to_csv(BATCHES_FILE, index=False)
                        batch = df_batch_view[
                            df_batch_view["Batch ID"].astype(str)
                            == selected_batch_id
                        ].iloc[0]
                        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        movement_id = datetime.now().strftime("%Y%m%d%H%M%S%f")
                        add_stock_movements([{
                            "Movement ID": f"ADJ-{movement_id}",
                            "Timestamp": timestamp,
                            "User": st.session_state.user_email,
                            "Movement Type": "Stock adjustment",
                            "Item Code": batch["Item Code"],
                            "Item Name": batch["Item Name"],
                            "Batch No": batch["Batch No"],
                            "Quantity Change": change,
                            "Previous Stock": previous_stock,
                            "New Stock": max(0.0, new_stock),
                            "Reason": (
                                f"{adjustment_reason}: {adjustment_notes.strip()}"
                                if adjustment_notes.strip()
                                else adjustment_reason
                            ),
                            "Reference": selected_batch_id,
                        }])
                        st.success("Stock adjustment recorded in the movement history.")
                        st.rerun()

    with inv_edit_tab:
        if df_products.empty:
            st.info("There are no products to edit.")
        else:
            selected_code = st.selectbox(
                "Product to edit",
                df_products["Item Code"].astype(str).tolist(),
                format_func=lambda code: (
                    f"{df_products.loc[df_products['Item Code'].astype(str) == code, 'Item Name'].iloc[0]} · {code}"
                ),
                key="edit_inv_select",
            )
            product = df_products[
                df_products["Item Code"].astype(str) == selected_code
            ].iloc[0]
            with st.form("edit_inv_form"):
                edit_col1, edit_col2, edit_col3 = st.columns(3)
                edit_name = edit_col1.text_input(
                    "Product name", value=str(product["Item Name"]), key="edit_inv_name"
                )
                edit_generic = edit_col2.text_input(
                    "Generic name",
                    value=str(product["Generic Name"]),
                    key="edit_inv_generic",
                )
                edit_category = edit_col3.text_input(
                    "Category", value=str(product["Category"]), key="edit_inv_category"
                )
                edit_col4, edit_col5, edit_col6 = st.columns(3)
                edit_manufacturer = edit_col4.text_input(
                    "Manufacturer",
                    value=str(product["Manufacturer"]),
                    key="edit_inv_manufacturer",
                )
                edit_barcode = edit_col5.text_input(
                    "Barcode", value=str(product["Barcode"]), key="edit_inv_barcode"
                )
                edit_location = edit_col6.text_input(
                    "Shelf / rack location",
                    value=str(product["Location"]),
                    key="edit_inv_location",
                )
                edit_col7, edit_col8, edit_col9, edit_col10 = st.columns(4)
                edit_unit = edit_col7.selectbox(
                    "Sale unit",
                    ["Tablet", "Strip", "Box", "Bottle", "Syrup (ml)", "Pack", "Other"],
                    index=(
                        ["Tablet", "Strip", "Box", "Bottle", "Syrup (ml)", "Pack", "Other"]
                        .index(product["Unit"])
                        if product["Unit"] in [
                            "Tablet", "Strip", "Box", "Bottle", "Syrup (ml)", "Pack", "Other"
                        ]
                        else 5
                    ),
                    key="edit_inv_unit",
                )
                edit_pack_size = edit_col8.number_input(
                    "Units per pack",
                    min_value=1,
                    value=max(1, int(float(product["Pack Size"]))),
                    key="edit_inv_pack_size",
                )
                edit_cost = edit_col9.number_input(
                    "Default purchase price (PKR)",
                    min_value=0.0,
                    value=float(product["Cost Price"]),
                    key="edit_inv_cost",
                )
                edit_selling_price = edit_col10.number_input(
                    "Sale price (PKR)",
                    min_value=0.0,
                    value=float(product["Selling Price"]),
                    key="edit_inv_sale",
                )
                edit_col11, edit_col12 = st.columns(2)
                edit_tax = edit_col11.number_input(
                    "Tax rate (%)",
                    min_value=0.0,
                    max_value=100.0,
                    value=float(product["Tax Rate"]),
                    key="edit_inv_tax",
                )
                edit_min_stock = edit_col12.number_input(
                    "Reorder level",
                    min_value=0.0,
                    value=float(product["Min Stock"]),
                    key="edit_inv_min",
                )
                if st.form_submit_button("Save product changes"):
                    other_barcodes = df_products[
                        df_products["Item Code"].astype(str) != selected_code
                    ]["Barcode"].fillna("").astype(str).str.strip().str.casefold()
                    if (
                        edit_barcode.strip()
                        and edit_barcode.strip().casefold() in other_barcodes.values
                    ):
                        st.error("That barcode is already assigned to another product.")
                    elif not edit_name.strip():
                        st.error("Product name is required.")
                    else:
                        product_index = df_products.index[
                            df_products["Item Code"].astype(str) == selected_code
                        ][0]
                        updated_product = {
                            "Item Name": edit_name.strip(),
                            "Generic Name": edit_generic.strip(),
                            "Category": edit_category.strip(),
                            "Manufacturer": edit_manufacturer.strip(),
                            "Barcode": edit_barcode.strip(),
                            "Location": edit_location.strip(),
                            "Unit": edit_unit,
                            "Pack Size": edit_pack_size,
                            "Cost Price": edit_cost,
                            "Selling Price": edit_selling_price,
                            "Tax Rate": edit_tax,
                            "Min Stock": edit_min_stock,
                        }
                        for column, value in updated_product.items():
                            df_products.at[product_index, column] = value
                        df_products.to_csv(PRODUCTS_FILE, index=False)
                        st.success("Product details updated.")
                        st.rerun()

            current_stock = float(
                df_batches.loc[
                    df_batches["Item Code"].astype(str) == selected_code, "Stock"
                ].sum()
            )
            if current_stock > 0:
                st.warning(
                    f"This product has {current_stock:g} packs in stock. Adjust or write off stock before removing the product."
                )
            elif st.button(
                "Remove product from catalog",
                key="del_inv_btn",
                icon=":material/delete:",
            ):
                df_products = df_products[
                    df_products["Item Code"].astype(str) != selected_code
                ]
                df_batches = df_batches[
                    df_batches["Item Code"].astype(str) != selected_code
                ]
                df_products.to_csv(PRODUCTS_FILE, index=False)
                df_batches.to_csv(BATCHES_FILE, index=False)
                st.success("Product removed from the catalog.")
                st.rerun()

    with inv_history_tab:
        if df_movements.empty:
            st.info("Stock receipts, sales and adjustments will appear here.")
        else:
            st.dataframe(
                df_movements.sort_values("Timestamp", ascending=False),
                hide_index=True,
                column_config={
                    "Quantity Change": st.column_config.NumberColumn(
                        "Quantity change", format="%+.2f"
                    ),
                    "Previous Stock": st.column_config.NumberColumn(
                        "Previous stock", format="%.2f"
                    ),
                    "New Stock": st.column_config.NumberColumn(
                        "New stock", format="%.2f"
                    ),
                },
            )

# ================= 4. UDHAAR KHATA =================
with tabs[3]:
    st.subheader("Customer credit and payment ledger", icon=":material/group:")

    u_sub1, u_sub2, u_sub3 = st.tabs(
        ["View customer accounts", "Add credit account", "Record payment / manage account"]
    )

    with u_sub1:
        st.dataframe(df_udhaar.rename(columns={"Khata ID": "Account ID"}))

    with u_sub2:
        with st.form("add_khata_form"):
            c1, c2, c3 = st.columns(3)
            kid = c1.text_input(
                "Account ID", value=f"K{len(df_udhaar)+1:03d}", key="add_k_id"
            )
            cname = c2.text_input("Customer Name", key="add_k_name")
            cphone = c3.text_input(
                "Phone Number", value="03316368566", key="add_k_phone"
            )

            details = st.text_input(
                "Details / Medicines", key="add_k_details"
            )
            c4, c5 = st.columns(2)
            bill = c4.number_input(
                "Total Bill", min_value=0.0, value=1000.0, key="add_k_bill"
            )
            paid = c5.number_input(
                "Amount Paid", min_value=0.0, value=0.0, key="add_k_paid"
            )

            if st.form_submit_button("Save credit account"):
                if not cname:
                    st.error("Customer Name is required.")
                else:
                    balance = bill - paid
                    status = "Pending" if balance > 0 else "Cleared"
                    new_k = pd.DataFrame(
                        [[kid, cname, cphone, details, bill, paid, balance, status]],
                        columns=df_udhaar.columns,
                    )
                    df_udhaar = pd.concat([df_udhaar, new_k], ignore_index=True)
                    df_udhaar.to_csv(UDHAAR_FILE, index=False)
                    st.success("Customer credit account added successfully.")
                    st.rerun()

    with u_sub3:
        if not df_udhaar.empty:
            sel_kid = st.selectbox(
                "Select account ID to modify",
                df_udhaar["Khata ID"].tolist(),
                key="edit_k_select",
            )
            k_row = df_udhaar[df_udhaar["Khata ID"] == sel_kid].iloc[0]

            st.write(
                f"**Customer:** {k_row['Customer']} | **Balance Due:**"
                f" PKR {k_row['Balance Due']}"
            )
            with st.form("update_khata_form"):
                add_amt = st.number_input(
                    "Add Partial Payment Amount",
                    min_value=0.0,
                    value=100.0,
                    key="up_k_add_amt",
                )
                if st.form_submit_button("Update Partial Payment"):
                    new_paid = float(k_row["Paid"]) + add_amt
                    new_balance = float(k_row["Total Bill"]) - new_paid
                    new_status = "Cleared" if new_balance <= 0 else "Pending"

                    df_udhaar.loc[df_udhaar["Khata ID"] == sel_kid, "Paid"] = (
                        new_paid
                    )
                    df_udhaar.loc[
                        df_udhaar["Khata ID"] == sel_kid, "Balance Due"
                    ] = new_balance
                    df_udhaar.loc[df_udhaar["Khata ID"] == sel_kid, "Status"] = (
                        new_status
                    )
                    df_udhaar.to_csv(UDHAAR_FILE, index=False)
                    st.success("Customer payment recorded successfully.")
                    st.rerun()

            if st.button("Delete this customer account", key="del_k_btn", icon=":material/delete:"):
                df_udhaar = df_udhaar[df_udhaar["Khata ID"] != sel_kid]
                df_udhaar.to_csv(UDHAAR_FILE, index=False)
                st.success("Customer credit account deleted successfully.")
                st.rerun()

            st.markdown("---")
            rem_phone = (
                str(k_row["Phone"]) if str(k_row["Phone"]) else "03316368566"
            )
            rem_msg = (
                f"Dear {k_row['Customer']}, this is a friendly payment reminder from {st.session_state.store_name} regarding your pending balance of PKR {k_row['Balance Due']}. Kindly clear your dues at your earliest convenience. Thank you!"
            )
            encoded_rem = urllib.parse.quote(rem_msg)
            wa_rem_link = f"https://wa.me/{rem_phone}?text={encoded_rem}"
            st.markdown(
                f'<a href="{wa_rem_link}" target="_blank"><button'
                " style=\"background-color:#2563eb; color:white; padding:10px 20px;"
                " border:none; border-radius:6px; font-weight:bold; cursor:pointer;\">📲"
                " Send WhatsApp Payment Reminder</button></a>",
                unsafe_allow_html=True,
            )
        else:
            st.info("No customer credit accounts found.")

# ================= 5. SUPPLIERS (With Automated WhatsApp Messaging) =================
with tabs[4]:
    st.subheader("🏭 Supplier & Distributor Management")

    sup_sub1, sup_sub2, sup_sub3 = st.tabs(
        ["📋 View Suppliers", "➕ Add Supplier", "🛠️ Edit / Delete Supplier"]
    )

    with sup_sub1:
        st.dataframe(df_sup)
        st.markdown("---")
        st.markdown("#### 📲 Send Automated WhatsApp Order / Inquiry to Supplier")
        if not df_sup.empty:
            sel_sup_msg = st.selectbox("Select Supplier for WhatsApp", df_sup["Supplier Name"].tolist(), key="sup_wa_select")
            sup_phone_num = str(df_sup.loc[df_sup["Supplier Name"] == sel_sup_msg, "Phone"].values[0])
            sup_inv_no = str(df_sup.loc[df_sup["Supplier Name"] == sel_sup_msg, "Invoice"].values[0])
            
            custom_order_msg = st.text_area("Message Content", value=f"Hello {sel_sup_msg}, regarding invoice {sup_inv_no}, we would like to place a restock order for our medical store. Kindly confirm availability. Thank you!")
            encoded_sup_msg = urllib.parse.quote(custom_order_msg)
            sup_wa_link = f"https://wa.me/{sup_phone_num}?text={encoded_sup_msg}"
            
            st.markdown(
                f'<a href="{sup_wa_link}" target="_blank"><button'
                " style=\"background-color:#2563eb; color:white; padding:10px 20px;"
                " border:none; border-radius:6px; font-weight:bold; cursor:pointer;\">📲"
                f" Send WhatsApp Message to {sel_sup_msg}</button></a>",
                unsafe_allow_html=True,
            )

    with sup_sub2:
        with st.form("add_sup_form"):
            c1, c2, c3 = st.columns(3)
            sid = c1.text_input(
                "Supplier ID", value=f"SUP{len(df_sup)+1:03d}", key="add_s_id"
            )
            sname = c2.text_input("Supplier Name", key="add_s_name")
            sphone = c3.text_input(
                "Phone Number", value="03316368566", key="add_s_phone"
            )

            c4, c5, c6, c7 = st.columns(4)
            inv = c4.text_input("Invoice No", value="INV-101", key="add_s_inv")
            tbill = c5.number_input(
                "Total Bill", min_value=0.0, value=10000.0, key="add_s_bill"
            )
            spaid = c6.number_input(
                "Paid Amount", min_value=0.0, value=5000.0, key="add_s_paid"
            )
            sstatus = c7.selectbox(
                "Status", ["Pending", "Paid"], key="add_s_status"
            )

            if st.form_submit_button("Save Supplier"):
                if not sname:
                    st.error("Supplier Name is required.")
                else:
                    balance = tbill - spaid
                    new_sup = pd.DataFrame(
                        [[
                            sid,
                            sname,
                            sphone,
                            inv,
                            tbill,
                            spaid,
                            balance,
                            sstatus,
                        ]],
                        columns=df_sup.columns,
                    )
                    df_sup = pd.concat([df_sup, new_sup], ignore_index=True)
                    df_sup.to_csv(SUP_FILE, index=False)
                    st.success("Supplier added successfully.")
                    st.rerun()

    with sup_sub3:
        if not df_sup.empty:
            sel_sid = st.selectbox(
                "Select Supplier ID to Modify",
                df_sup["Supplier ID"].tolist(),
                key="edit_s_select",
            )
            sup_row = df_sup[df_sup["Supplier ID"] == sel_sid].iloc[0]

            with st.form("edit_sup_form"):
                up_sname = st.text_input(
                    "Supplier Name",
                    value=str(sup_row["Supplier Name"]),
                    key="up_s_name",
                )
                up_tbill = st.number_input(
                    "Total Bill",
                    min_value=0.0,
                    value=float(sup_row["Total Bill"]),
                    key="up_s_bill",
                )
                up_paid = st.number_input(
                    "Paid Amount",
                    min_value=0.0,
                    value=float(sup_row["Paid"]),
                    key="up_s_paid",
                )
                if st.form_submit_button("Update Supplier"):
                    new_bal = up_tbill - up_paid
                    new_stat = "Paid" if new_bal <= 0 else "Pending"
                    df_sup.loc[
                        df_sup["Supplier ID"] == sel_sid, "Supplier Name"
                    ] = up_sname
                    df_sup.loc[df_sup["Supplier ID"] == sel_sid, "Total Bill"] = (
                        up_tbill
                    )
                    df_sup.loc[df_sup["Supplier ID"] == sel_sid, "Paid"] = (
                        up_paid
                    )
                    df_sup.loc[
                        df_sup["Supplier ID"] == sel_sid, "Balance Due"
                    ] = new_bal
                    df_sup.loc[df_sup["Supplier ID"] == sel_sid, "Status"] = (
                        new_stat
                    )
                    df_sup.to_csv(SUP_FILE, index=False)
                    st.success("Supplier updated successfully.")
                    st.rerun()

            if st.button("🗑️ Delete This Supplier", key="del_sup_btn"):
                df_sup = df_sup[df_sup["Supplier ID"] != sel_sid]
                df_sup.to_csv(SUP_FILE, index=False)
                st.success("Supplier deleted successfully.")
                st.rerun()
        else:
            st.info("No supplier records found.")

# ================= 6. EXPENSES =================
with tabs[5]:
    st.subheader("💸 Daily Operational Expenses Management")

    exp_sub1, exp_sub2, exp_sub3 = st.tabs(
        ["📋 View Expenses", "➕ Add Expense", "🛠️ Edit / Delete Expense"]
    )

    with exp_sub1:
        st.dataframe(df_exp)

    with exp_sub2:
        with st.form("add_exp_form"):
            c1, c2 = st.columns(2)
            e_id = c1.text_input(
                "Expense ID", value=f"EXP{len(df_exp)+1:03d}", key="add_e_id"
            )
            e_date = c2.text_input(
                "Date", value=str(datetime.today().date()), key="add_e_date"
            )
            cat = st.selectbox(
                "Category",
                ["Utility", "Rent", "Staff Salary", "Miscellaneous"],
                key="add_e_cat",
            )
            desc = st.text_input(
                "Description", value="Shop Bill", key="add_e_desc"
            )
            amt = st.number_input(
                "Amount (PKR)", min_value=0.0, value=500.0, key="add_e_amt"
            )

            if st.form_submit_button("Save Expense"):
                if not desc:
                    st.error("Description is required.")
                else:
                    new_ex = pd.DataFrame(
                        [[e_id, e_date, cat, desc, amt]], columns=df_exp.columns
                    )
                    df_exp = pd.concat([df_exp, new_ex], ignore_index=True)
                    df_exp.to_csv(EXP_FILE, index=False)
                    st.success("Expense added successfully.")
                    st.rerun()

    with exp_sub3:
        if not df_exp.empty:
            sel_eid = st.selectbox(
                "Select Expense ID to Modify",
                df_exp["Expense ID"].tolist(),
                key="edit_e_select",
            )
            e_row = df_exp[df_exp["Expense ID"] == sel_eid].iloc[0]

            with st.form("edit_exp_form"):
                up_desc = st.text_input(
                    "Description",
                    value=str(e_row["Description"]),
                    key="up_e_desc",
                )
                up_amt = st.number_input(
                    "Amount",
                    min_value=0.0,
                    value=float(e_row["Amount"]),
                    key="up_e_amt",
                )
                if st.form_submit_button("Update Expense"):
                    df_exp.loc[
                        df_exp["Expense ID"] == sel_eid, "Description"
                    ] = up_desc
                    df_exp.loc[df_exp["Expense ID"] == sel_eid, "Amount"] = up_amt
                    df_exp.to_csv(EXP_FILE, index=False)
                    st.success("Expense updated successfully.")
                    st.rerun()

            if st.button("🗑️ Delete This Expense", key="del_exp_btn"):
                df_exp = df_exp[df_exp["Expense ID"] != sel_eid]
                df_exp.to_csv(EXP_FILE, index=False)
                st.success("Expense deleted successfully.")
                st.rerun()
        else:
            st.info("No expense records found.")

# ================= 7. STORE SETTINGS (CUSTOMIZE STORE NAME) =================
with tabs[6]:
    st.subheader("⚙️ Store Profile & Customization")
    st.markdown("Update your medical store brand name here. Changes will automatically reflect across the enterprise application header and customer receipts without causing any data loss.")

    with st.form("store_settings_form"):
        new_store_title = st.text_input("Medical Store Name", value=st.session_state.store_name)
        update_store_btn = st.form_submit_button("Save Store Name")

        if update_store_btn:
            if not new_store_title:
                st.error("Store name cannot be left blank.")
            else:
                df_users.loc[df_users["Email"] == st.session_state.user_email, "StoreName"] = new_store_title
                df_users.to_csv(USERS_FILE, index=False)
                
                st.session_state.store_name = new_store_title
                st.success("Store name updated successfully! Refreshing workspace...")
                st.rerun()