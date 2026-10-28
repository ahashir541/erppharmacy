import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, Banknote, Bell, Boxes,
  BriefcaseMedical, Building2, CalendarDays, Check, ChevronDown, ChevronLeft,
  ChevronRight, CircleHelp, Command, CreditCard, FileBarChart, FileClock, BookOpen, MessageCircle,
  LayoutDashboard, LogOut, Menu, Moon, Package, Plus, Search, Settings,
  Receipt, ShieldCheck, ShoppingBag, ShoppingCart, Sun, Users, Wallet, X,
} from "lucide-react";
import { api, getToken, patch, post, saveToken } from "./api";

type User = { id: string; name: string; email: string; role: string; store_id: string };
type Product = {
  id: string; sku: string; name: string; generic_name: string; category: string;
  manufacturer: string; barcode: string | null; unit: string; pack_size: number;
  purchase_price: number | null; sale_price: number; tax_rate: number; reorder_level: number;
  shelf_location: string; is_active: boolean; stock: number; inventory_value: number | null;
};
type Customer = { id: string; name: string; phone: string | null; credit_limit: number };
type Supplier = { id: string; name: string; phone: string | null };
type Dashboard = {
  today: { sales: number | null; profit: number | null; transactions: number };
  inventory: { value: number | null; low_stock_products: number; expiring_batches: number; expired_batches: number };
  receivables: number | null; payables: number | null;
  cash_balance: number | null; bank_balance: number | null;
  trend: { date: string; sales: number; profit?: number }[];
  top_products: { product_id: string; name: string; quantity: number; revenue: number | null }[];
  payment_breakdown: { method: string; amount: number }[];
  recent_transactions: { id: string; invoice_number: string; created_at: string; total: number | null; status: string }[];
  management: {
    period: "weekly" | "monthly" | "yearly";
    start_date: string;
    end_date: string;
    sales: number | null;
    gross_profit: number | null;
    expenses: number | null;
    net_after_expenses: number | null;
    transactions: number;
    trend: { date: string; sales: number | null; profit: number | null; expenses: number | null; transactions: number }[];
  };
};
type Row = Record<string, unknown>;
type BillingStatus = {
  pharmacy_name: string;
  status: string;
  plan_code: string;
  trial_ends_at: string | null;
  subscription_expires_at: string | null;
  restricted: boolean;
};
type SubscriptionInvoice = {
  id: string;
  invoice_number: string;
  plan_code: string;
  amount: number;
  currency: string;
  period_start: string;
  period_end: string;
  due_at: string;
  status: string;
  payment_method: string | null;
  payment_reference: string | null;
  paid_amount: number | null;
  review_note: string;
};
type PaymentInstruction = {
  method: string;
  label: string;
  account_name?: string;
  account_number?: string;
  bank_name?: string;
  account_title?: string;
  iban?: string;
  instructions?: string;
};
type Module = "Dashboard" | "Point of sale" | "Inventory" | "Sales" | "Purchases" |
  "Customers" | "Suppliers" | "Accounting" | "Expenses" | "Credit accounts" | "Reports" |
  "Users & access" | "Operating guide" | "Subscription" | "Settings";

const navigation: { label: Module; icon: typeof LayoutDashboard; group: string }[] = [
  { label: "Dashboard", icon: LayoutDashboard, group: "Overview" },
  { label: "Point of sale", icon: ShoppingCart, group: "Operations" },
  { label: "Inventory", icon: Boxes, group: "Operations" },
  { label: "Sales", icon: ShoppingBag, group: "Operations" },
  { label: "Purchases", icon: Package, group: "Operations" },
  { label: "Customers", icon: Users, group: "Relationships" },
  { label: "Suppliers", icon: Building2, group: "Relationships" },
  { label: "Accounting", icon: Wallet, group: "Finance" },
  { label: "Expenses", icon: Receipt, group: "Finance" },
  { label: "Credit accounts", icon: CreditCard, group: "Finance" },
  { label: "Reports", icon: FileBarChart, group: "Finance" },
  { label: "Users & access", icon: ShieldCheck, group: "Administration" },
  { label: "Subscription", icon: CreditCard, group: "Administration" },
  { label: "Settings", icon: Settings, group: "Administration" },
  { label: "Operating guide", icon: BookOpen, group: "Help" },
];

const currency = (amount: number | null | undefined) =>
  amount == null ? "Restricted" : new Intl.NumberFormat("en", {
    style: "currency", currency: localStorage.getItem("erp-currency") ?? "PKR", maximumFractionDigits: 0,
  }).format(Number(amount));
const receiptCurrency = (amount: number) => new Intl.NumberFormat("en", {
  style: "currency", currency: localStorage.getItem("erp-currency") ?? "PKR",
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(Number(amount));

function App() {
  return window.location.pathname.startsWith("/platform")
    ? <PlatformConsole />
    : <TenantWorkspace />;
}

type Tenant = {
  id: string;
  name: string;
  status: string;
  plan_code: string;
  currency: string;
  trial_ends_at: string | null;
  subscription_expires_at: string | null;
  user_count: number;
  created_at: string;
  today_sales: number;
  today_transactions: number;
  medicine_count: number;
  low_stock_products: number;
  expiring_batches: number;
  expired_batches: number;
  receivables: number;
  payables: number;
};

function PlatformConsole() {
  const [operator, setOperator] = useState<{ id: string; name: string; email: string } | null>(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const [error, setError] = useState("");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [provisioning, setProvisioning] = useState(false);
  const [passwordForm, setPasswordForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [billingTenant, setBillingTenant] = useState<Tenant | null>(null);
  const {
    data: billingInvoices,
    error: billingError,
    loading: billingLoading,
    reload: reloadBillingInvoices,
  } = useLoad<SubscriptionInvoice[]>(
    billingTenant ? `/api/platform/tenants/${billingTenant.id}/invoices` : "/api/platform/tenants",
    Boolean(billingTenant),
  );
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const identity = await api<{ id: string; name: string; email: string }>("/api/platform/auth/me");
      const accounts = await api<Tenant[]>(
        `/api/platform/tenants?timezone_name=${encodeURIComponent(browserTimezone())}`,
      );
      setOperator(identity);
      setTenants(accounts);
      setError("");
    } catch (cause) {
      saveToken(null);
      setOperator(null);
      setError(cause instanceof Error ? cause.message : "Unable to load pharmacy accounts.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (getToken()) void refresh(); else setLoading(false); }, [refresh]);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const body = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await post<{ access_token: string }>("/api/platform/auth/login", body);
      saveToken(result.access_token);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to sign in."); }
    finally { setBusy(false); }
  }
  async function createTenant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    try {
      const result = await post<{ pharmacy: Tenant; administrator: { email: string } }>("/api/platform/tenants", {
        ...body, trial_days: Number(body.trial_days),
      });
      setNotice(`Pharmacy created. Admin sign-in: ${result.administrator.email}. Share the temporary password securely.`);
      setProvisioning(false);
      form.reset();
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to provision pharmacy."); }
    finally { setBusy(false); }
  }
  async function changeTenant(tenant: Tenant, status: string, planCode = tenant.plan_code) {
    try {
      await patch(`/api/platform/tenants/${tenant.id}`, { status, plan_code: planCode, trial_days: status === "trial" ? 30 : null });
      setNotice(`${tenant.name} status updated to ${status}.`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update pharmacy."); }
  }
  async function createBillingInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!billingTenant) return;
    setError("");
    setBusy(true);
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await post(`/api/platform/tenants/${billingTenant.id}/invoices`, {
        ...body,
        amount: Number(body.amount),
        duration_days: Number(body.duration_days),
        due_days: Number(body.due_days),
      });
      setNotice(`Subscription invoice issued for ${billingTenant.name}.`);
      form.reset();
      reloadBillingInvoices();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create invoice."); }
    finally { setBusy(false); }
  }
  async function reviewBillingInvoice(invoice: SubscriptionInvoice, status: "paid" | "rejected") {
    const note = status === "paid"
      ? "Payment verified against the receiving wallet or bank account."
      : window.prompt("Why is this payment being rejected?");
    if (note === null) return;
    try {
      await patch(`/api/platform/invoices/${invoice.id}/review`, { status, note });
      setNotice(status === "paid" ? `${invoice.invoice_number} approved and subscription activated.` : `${invoice.invoice_number} payment rejected.`);
      reloadBillingInvoices();
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to review payment."); }
  }
  async function changeOperatorPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    if (body.new_password !== body.confirm_password) { setError("The new passwords do not match."); return; }
    try {
      await post("/api/platform/auth/password", { current_password: body.current_password, new_password: body.new_password });
      saveToken(null);
      setOperator(null);
      setPasswordForm(false);
      setError("Password updated. Sign in again with the new password.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to change password."); }
  }
  if (loading) return <div className="boot"><div className="brand-mark"><BriefcaseMedical size={22} /></div><div className="skeleton boot-line" /></div>;
  if (!operator) return <div className="login-screen"><div className="login-card"><div className="brand-mark"><Building2 size={22} /></div><p className="eyebrow">SYED HASHIR ALI · MEDFLOW MASTERBOARD</p><h1>Owner sign in</h1><p className="subtle">The masterboard is reserved for the MedFlow platform owner. Manage pharmacy accounts and monitor their operations.</p><form className="stack-form" onSubmit={signIn}><label>Owner email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label>{error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}<button className="button primary full" disabled={busy}>{busy ? "Signing in..." : "Sign in to masterboard"}</button></form><a className="platform-link" href="/">Go to pharmacy sign in</a><p className="login-credit">Built by Syed Hashir Ali</p></div></div>;
  return <div className="platform-shell"><header className="platform-topbar"><a href="/platform" className="brand platform-brand"><span className="brand-mark"><BriefcaseMedical size={20} /></span><span><strong>MedFlow</strong><small>SYED HASHIR ALI · MASTERBOARD</small></span></a><span className="platform-operator"><span className="avatar">{operator.name.slice(0,1).toUpperCase()}</span>{operator.name}<button className="button secondary small" onClick={() => setPasswordForm(!passwordForm)}>Security</button><button className="button secondary small" onClick={() => { saveToken(null); setOperator(null); }}>Sign out</button></span></header>
    <main className="platform-content"><div className="page-heading"><div><p className="eyebrow">SYED HASHIR ALI · PLATFORM OWNER</p><h1>MedFlow masterboard</h1><p className="subtle">One platform-owner console for pharmacy accounts, subscriptions, and each store’s daily operations.</p></div><button className="button primary" onClick={() => { setError(""); setProvisioning(!provisioning); }}><Plus size={16} />Provision pharmacy</button></div>
      {notice && <div className="platform-notice"><Check size={16} />{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><X size={14} /></button></div>}
      {error && <div className="form-error"><AlertTriangle size={16} />{error}<button onClick={() => setError("")} aria-label="Dismiss"><X size={14} /></button></div>}
      {passwordForm && <form className="form-panel" onSubmit={changeOperatorPassword}><h2>Change platform password</h2><div className="form-grid"><label>Current password<input type="password" name="current_password" autoComplete="current-password" required /></label><label>New password<input type="password" name="new_password" autoComplete="new-password" minLength={14} required /></label><label>Confirm new password<input type="password" name="confirm_password" autoComplete="new-password" minLength={14} required /></label></div><FormActions cancel={() => setPasswordForm(false)} submit="Change password" /></form>}
      {provisioning && <form className="form-panel" onSubmit={createTenant}><h2>New pharmacy account</h2><p className="subtle">Creates an isolated pharmacy workspace and its first administrator.</p><div className="form-grid"><label>Pharmacy name<input name="pharmacy_name" required /></label><label>Administrator name<input name="administrator_name" required /></label><label>Administrator email<input name="administrator_email" type="email" required /></label><label>Temporary password<input name="administrator_password" type="password" minLength={14} required /><small>At least 14 characters. Deliver it to the customer securely.</small></label><label>Plan<select name="plan_code"><option value="starter">Starter</option><option value="professional">Professional</option><option value="enterprise">Enterprise</option></select></label><label>Trial days<input name="trial_days" type="number" min="0" max="90" defaultValue="30" required /><small>Use 0 to activate immediately.</small></label></div><FormActions cancel={() => setProvisioning(false)} submit={busy ? "Provisioning..." : "Create pharmacy"} /></form>}
      {billingTenant && <section className="panel table-panel"><div className="panel-header"><div><h2>Billing · {billingTenant.name}</h2><p>Create an invoice and reconcile local wallet or bank payments.</p></div><button className="button secondary small" onClick={() => setBillingTenant(null)}>Close</button></div>
        <form className="form-panel" onSubmit={(event) => void createBillingInvoice(event)}><h3>Issue subscription invoice</h3><p className="subtle">A payment becomes active only after a MedFlow operator confirms settled funds.</p><div className="form-grid"><label>Plan<select name="plan_code" defaultValue={billingTenant.plan_code}><option value="starter">Starter</option><option value="professional">Professional</option><option value="enterprise">Enterprise</option></select></label><label>Amount ({billingTenant.currency})<input name="amount" type="number" min="0.01" step="0.01" required /></label><label>Subscription duration<select name="duration_days" defaultValue="30"><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">365 days</option></select></label><label>Due in (days)<input name="due_days" type="number" min="1" max="30" defaultValue="7" required /></label></div><div className="form-actions"><button className="button primary" disabled={busy}><Plus size={16} />{busy ? "Creating..." : "Create invoice"}</button></div></form>
        <p className="platform-disclaimer"><ShieldCheck size={15} />Verify the transaction in your receiving account; never approve using a screenshot or client-side callback alone.</p>
        {billingError ? <ErrorPanel message={billingError} onRetry={reloadBillingInvoices} /> : billingLoading ? <TableSkeleton /> : <DataTable rows={(billingInvoices ?? []) as unknown as Row[]} fields={["invoice_number", "plan_code", "amount", "status", "payment_method", "payment_reference", "due_at"]} empty="No invoices issued for this pharmacy yet." actions={(row) => {
          const invoice = billingInvoices?.find((item) => item.id === row.id);
          return invoice?.status === "submitted" ? <div className="tenant-actions"><button className="button primary small" onClick={() => void reviewBillingInvoice(invoice, "paid")}>Confirm received</button><button className="button secondary small" onClick={() => void reviewBillingInvoice(invoice, "rejected")}>Reject</button></div> : null;
        }} />}
      </section>}
      <div className="platform-stats"><div className="metric-card"><span className="metric-top">Total pharmacies</span><div className="metric-value">{tenants.length}</div></div><div className="metric-card"><span className="metric-top">Active accounts</span><div className="metric-value">{tenants.filter((tenant) => tenant.status === "active").length}</div></div><div className="metric-card"><span className="metric-top">Trials</span><div className="metric-value">{tenants.filter((tenant) => tenant.status === "trial").length}</div></div><div className="metric-card"><span className="metric-top">Suspended</span><div className="metric-value">{tenants.filter((tenant) => tenant.status === "suspended").length}</div></div></div>
      <section className="panel table-panel"><div className="table-toolbar"><strong>Pharmacy operations snapshot</strong><button className="button secondary small" onClick={() => void refresh()}><Activity size={15} />Refresh</button></div><p className="platform-table-note">Sales, receivables, and payables are shown in each pharmacy’s own currency. Staff account details remain inside that pharmacy workspace.</p><DataTable rows={tenants as unknown as Row[]} fields={["name", "status", "plan_code", "currency", "today_sales", "today_transactions", "medicine_count", "low_stock_products", "expiring_batches", "expired_batches", "receivables", "payables", "user_count"]} labels={{name:"Pharmacy", status:"Account status", plan_code:"Plan", currency:"Currency", today_sales:"Sales today", today_transactions:"Transactions", medicine_count:"Products", low_stock_products:"Low stock", expiring_batches:"Near expiry", expired_batches:"Expired", receivables:"Receivables", payables:"Payables", user_count:"Users"}} empty="No pharmacies onboarded. Provision the first customer pharmacy." actions={(row) => { const tenant = tenants.find((item) => item.id === row.id); if (!tenant) return null; return <div className="tenant-actions"><button className="button secondary small" onClick={() => setBillingTenant(tenant)}>Billing</button><select className="tenant-status-select" aria-label={`Account status for ${tenant.name}`} value={tenant.status} onChange={(event) => void changeTenant(tenant, event.target.value)}><option value="trial">Trial</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="cancelled">Cancelled</option></select><select className="tenant-status-select" aria-label={`Plan for ${tenant.name}`} value={tenant.plan_code} onChange={(event) => void changeTenant(tenant, tenant.status, event.target.value)}><option value="starter">Starter</option><option value="professional">Professional</option><option value="enterprise">Enterprise</option></select></div>; }} /></section>
      <p className="platform-disclaimer"><ShieldCheck size={15} />JazzCash, Easypaisa, and bank transfers are reconciled manually. Automated provider checkout, refunds, and recurring charges are not enabled.</p>
      <p className="platform-credit">MedFlow · Built by Syed Hashir Ali</p>
    </main>
  </div>;
}

function TenantWorkspace() {
  const [user, setUser] = useState<User | null>(null);
  const [module, setModule] = useState<Module>("Dashboard");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [searchError, setSearchError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [dark, setDark] = useState(() => localStorage.getItem("erp-theme") === "dark");
  const [toast, setToast] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(Boolean(getToken()));
  const { data: store } = useLoad<{ name: string; currency: string; tenant_status: string; plan_code: string; trial_ends_at: string | null }>("/api/store", Boolean(user));
  const { data: billingStatus, reload: reloadBillingStatus } = useLoad<{ restricted: boolean }>("/api/billing/status", Boolean(user));

  useEffect(() => {
    if (billingStatus?.restricted) setModule("Subscription");
  }, [billingStatus?.restricted]);

  useEffect(() => {
    if (user && module === "Subscription") reloadBillingStatus();
  }, [module, user, reloadBillingStatus]);

  useEffect(() => {
    if (store?.currency) localStorage.setItem("erp-currency", store.currency);
    if (store?.name) localStorage.setItem("erp-store-name", store.name);
  }, [store?.currency, store?.name]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("erp-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    if (!getToken()) { setBusy(false); return; }
    api<User>("/api/auth/me")
      .then(setUser)
      .catch(() => { saveToken(null); setUser(null); })
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [user]);

  useEffect(() => {
    const term = searchText.trim();
    if (!searchOpen || term.length < 2) { setSearchResults([]); setSearchError(""); return; }
    const timer = window.setTimeout(() => {
      api<Product[]>(`/api/products?search=${encodeURIComponent(term)}`)
        .then(setSearchResults)
        .catch((cause: unknown) => setSearchError(cause instanceof Error ? cause.message : "Search failed."));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [searchOpen, searchText]);

  if (busy) return <div className="boot"><div className="brand-mark"><BriefcaseMedical size={22} /></div><div className="skeleton boot-line" /></div>;
  if (!user) return <Login onLogin={setUser} error={loginError} setError={setLoginError} />;

  const financialAccess = ["owner", "admin", "accountant"].includes(user.role);
  const visibleNavigation = navigation.filter((item) => {
    if (["Sales", "Purchases", "Accounting", "Expenses", "Credit accounts", "Reports"].includes(item.label)) return financialAccess;
    if (["Users & access", "Settings", "Subscription"].includes(item.label)) return user.role === "owner";
    return true;
  });
  const groups = [...new Set(visibleNavigation.map((item) => item.group))];
  return (
    <div className={`app-shell ${collapsed ? "is-collapsed" : ""}`}>
      <aside className={`sidebar ${mobileMenu ? "mobile-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><BriefcaseMedical size={20} /></div>
          {!collapsed && <div><strong>MedFlow</strong><span>PHARMACY ERP</span></div>}
          <button className="icon-button sidebar-close" aria-label="Close menu" onClick={() => setMobileMenu(false)}><X size={18} /></button>
        </div>
        <button className="store-switch"><span className="store-avatar">{store?.name?.slice(0, 1).toUpperCase() ?? "M"}</span>{!collapsed && <><span className="store-name">{store?.name ?? "Pharmacy workspace"}<small>{store?.plan_code ? `${store.plan_code} plan` : "Loading pharmacy"}</small></span><ChevronDown size={15} /></>}</button>
        <nav className="nav">
          {groups.map((group) => <section className="nav-group" key={group}>
            {!collapsed && <div className="nav-caption">{group}</div>}
            {visibleNavigation.filter((item) => item.group === group).map(({ label, icon: Icon }) => (
              <button key={label} title={collapsed ? label : undefined}
                className={`nav-item ${module === label ? "active" : ""}`}
                onClick={() => { setModule(label); setMobileMenu(false); }}>
                <Icon size={18} strokeWidth={1.8} />{!collapsed && <span>{label}</span>}
                {label === "Inventory" && !collapsed && <em className="nav-count">3</em>}
              </button>
            ))}
          </section>)}
        </nav>
        <div className="sidebar-bottom">
          {!collapsed && <p className="product-credit">MedFlow · Built by Syed Hashir Ali</p>}
          <div className="help-card"><CircleHelp size={17} />{!collapsed && <span>Need help? <small>Visit help center</small></span>}</div>
          <button className="user-profile" onClick={() => { saveToken(null); setUser(null); }}>
            <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
            {!collapsed && <span className="profile-info"><strong>{user.name}</strong><small>{user.role}</small></span>}
            {!collapsed && <LogOut size={16} className="logout" />}
          </button>
        </div>
      </aside>
      {mobileMenu && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button menu-toggle" aria-label="Open menu" onClick={() => setMobileMenu(true)}><Menu size={20} /></button>
            <button className="icon-button collapse-toggle" aria-label="Collapse sidebar" onClick={() => setCollapsed(!collapsed)}><ChevronLeft size={18} /></button>
            <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>{module}</strong></div>
          </div>
          <div className="topbar-actions">
            <div className="search-wrap"><div className="global-search"><Search size={16} /><input ref={searchRef} value={searchText} onFocus={() => setSearchOpen(true)} onChange={(event) => setSearchText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && searchText.trim()) { setModule("Inventory"); setSearchOpen(false); } }} placeholder="Search products..." /><kbd>⌘ K</kbd></div>
              {searchOpen && searchText.trim().length >= 2 && <div className="search-popover">{searchError ? <p className="search-message">{searchError}</p> : searchResults.length ? searchResults.slice(0, 6).map((product) => <button key={product.id} onClick={() => { setSearchText(product.name); setModule("Inventory"); setSearchOpen(false); }}><Package size={16} /><span><strong>{product.name}</strong><small>{product.sku} · {product.stock} in stock</small></span><ChevronRight size={15} /></button>) : <p className="search-message">Searching products...</p>}</div>}
            </div>
            <button className="icon-button theme-toggle" title="Toggle theme" onClick={() => setDark(!dark)}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
            <button className="icon-button notification-button" aria-label="Notifications" onClick={() => setModule("Inventory")}><Bell size={18} /><i /></button>
            <span className="topbar-divider" />
            <button className="topbar-user" onClick={() => { saveToken(null); setUser(null); }}><span className="avatar small">{user.name.slice(0, 1).toUpperCase()}</span><ChevronDown size={14} /></button>
          </div>
        </header>
        <div className="page-content">
          {billingStatus?.restricted && <div className="trial-banner"><Activity size={15} />Pharmacy access is restricted. Review your subscription and payment options.<button className="text-button" onClick={() => setModule("Subscription")}>Open billing</button></div>}
          {store?.tenant_status === "trial" && store.trial_ends_at && !billingStatus?.restricted && <div className="trial-banner"><Activity size={15} />Free trial ends {new Date(store.trial_ends_at).toLocaleDateString("en", { dateStyle: "medium" })}. <button className="text-button" onClick={() => setModule("Subscription")}>View subscription</button></div>}
          {module === "Dashboard" ? <DashboardPage user={user} notify={notify} setModule={setModule} /> :
            module === "Point of sale" ? <POSPage notify={notify} /> :
            module === "Inventory" ? <InventoryPage notify={notify} initialSearch={searchText} /> :
            <ModulePage module={module} user={user} notify={notify} refreshBillingStatus={reloadBillingStatus} />}
        </div>
      </main>
      {toast && <div className="toast"><Check size={17} />{toast}</div>}
    </div>
  );
}
function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function Login({ onLogin, error, setError }: {
  onLogin: (user: User) => void; error: string; setError: (message: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError("");
    try {
      const result = await post<{ access_token: string; user: User }>("/api/auth/login", { email, password });
      saveToken(result.access_token); onLogin(result.user);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to sign in."); }
    finally { setLoading(false); }
  }
  return <div className="login-screen">
    <div className="login-card">
      <div className="brand-mark"><BriefcaseMedical size={23} /></div>
      <p className="eyebrow">MEDFLOW WORKSPACE</p><h1>Welcome back</h1>
      <p className="subtle">Sign in to manage your pharmacy operations.</p>
      <form onSubmit={submit} className="stack-form">
        <label>Email address<input autoComplete="username" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@pharmacy.com" /></label>
        <label>Password<input autoComplete="current-password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" /></label>
        {error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}
        <button className="button primary full" disabled={loading}>{loading ? "Signing in..." : "Sign in"}<ChevronRight size={17} /></button>
      </form>
      <p className="login-foot"><ShieldCheck size={14} /> Secure, store-scoped access</p>
      <a className="platform-link" href="/platform">Platform masterboard · Syed Hashir Ali only</a>
      <p className="login-credit">MedFlow · Built by Syed Hashir Ali</p>
    </div>
  </div>;
}

function DashboardPage({ user, notify, setModule }: {
  user: User; notify: (message: string) => void; setModule: (module: Module) => void;
}) {
  const [period, setPeriod] = useState<"weekly" | "monthly" | "yearly">("weekly");
  const { data, error, loading, reload } = useLoad<Dashboard>(
    `/api/dashboard?period=${period}&timezone_name=${encodeURIComponent(browserTimezone())}`,
  );
  const restricted = !["owner", "admin", "accountant"].includes(user.role);
  const metrics = [
    ...(!restricted ? [{ label: "Today's sales", value: currency(data?.today.sales), icon: Banknote, tone: "teal", foot: `${data?.today.transactions ?? 0} transactions` }] : [
      { label: "Today's transactions", value: String(data?.today.transactions ?? 0), icon: ShoppingBag, tone: "teal", foot: "Completed sales" },
    ]),
    ...(!restricted ? [{ label: "Today's profit", value: currency(data?.today.profit), icon: Activity, tone: "green", foot: "After cost of goods" }] : []),
    ...(!restricted ? [{ label: "Inventory value", value: currency(data?.inventory.value), icon: Boxes, tone: "blue", foot: "At purchase cost" }] : []),
    { label: "Low stock", value: String(data?.inventory.low_stock_products ?? 0), icon: AlertTriangle, tone: "amber", foot: "Needs replenishment" },
    { label: "Expiring soon", value: String(data?.inventory.expiring_batches ?? 0), icon: CalendarDays, tone: "rose", foot: `${data?.inventory.expired_batches ?? 0} already expired` },
    ...(!restricted ? [
      { label: "Receivables", value: currency(data?.receivables), icon: CreditCard, tone: "purple", foot: "Customer balances" },
      { label: "Payables", value: currency(data?.payables), icon: Building2, tone: "slate", foot: "Supplier balances" },
      { label: "Cash in hand", value: currency(data?.cash_balance), icon: Banknote, tone: "green", foot: "Ledger balance" },
      { label: "Bank balance", value: currency(data?.bank_balance), icon: Building2, tone: "blue", foot: "Ledger balance" },
    ] : []),
  ];
  return <div className="page-stack">
    <div className="page-heading">
      <div><p className="eyebrow">{new Date().toLocaleDateString("en", { weekday: "long", month: "long", day: "numeric" })}</p><h1>Good {new Date().getHours() < 12 ? "morning" : "afternoon"}, {user.name.split(" ")[0]}</h1><p className="subtle">Here is what's happening at your pharmacy today.</p></div>
      <div className="heading-actions"><button className="button secondary" onClick={reload}><Activity size={16} />Refresh</button><button className="button primary" onClick={() => setModule("Point of sale")}><Plus size={17} />New sale</button></div>
    </div>
    <div className="quick-actions">
      <button onClick={() => setModule("Point of sale")}><ShoppingCart size={17} /><span>New sale</span><ChevronRight size={15} /></button>
      <button onClick={() => setModule("Purchases")}><Package size={17} /><span>Receive stock</span><ChevronRight size={15} /></button>
      <button onClick={() => setModule("Inventory")}><Plus size={17} /><span>Add product</span><ChevronRight size={15} /></button>
      <button onClick={() => setModule("Customers")}><Users size={17} /><span>Add customer</span><ChevronRight size={15} /></button>
    </div>
    {error ? <ErrorPanel message={error} onRetry={reload} /> : <>
      <div className="metric-grid">{metrics.map((item) => {
        const Icon = item.icon;
        return <div className="metric-card" key={item.label}><div className="metric-top"><span>{item.label}</span><span className={`metric-icon ${item.tone}`}><Icon size={17} /></span></div><div className="metric-value">{loading ? <span className="skeleton value-skeleton" /> : item.value}</div><div className="metric-foot"><span>{item.foot}</span></div></div>;
      })}</div>
      {!restricted && data?.management && <section className="management-summary" aria-label={`${period} management summary`}>
        <div><span>{period[0].toUpperCase() + period.slice(1)} sales</span><strong>{loading ? "Loading..." : currency(data.management.sales)}</strong><small>{data.management.transactions} completed sales</small></div>
        <div><span>Gross profit</span><strong>{loading ? "Loading..." : currency(data.management.gross_profit)}</strong><small>Before operating expenses</small></div>
        <div><span>Shop expenses</span><strong>{loading ? "Loading..." : currency(data.management.expenses)}</strong><small>Recorded in this period</small></div>
        <div><span>Profit after expenses</span><strong>{loading ? "Loading..." : currency(data.management.net_after_expenses)}</strong><small>Gross profit less recorded expenses</small></div>
      </section>}
      <div className="dashboard-grid">
        <section className="panel trend-panel"><div className="panel-header"><div><h2>{restricted ? "Sales activity" : "Sales & management"}</h2><p>{period === "weekly" ? "Current week, Monday to Sunday" : period === "monthly" ? "Current calendar month" : "Current calendar year"}{restricted ? " · completed sales" : ""}</p></div><div className="period-switch" role="group" aria-label="Management reporting period">{(["weekly", "monthly", "yearly"] as const).map((option) => <button key={option} className={period === option ? "active" : ""} aria-pressed={period === option} onClick={() => setPeriod(option)}>{option[0].toUpperCase() + option.slice(1)}</button>)}</div></div>
          {loading ? <ChartSkeleton /> : <TrendChart endLabel={period === "weekly" ? "Week end" : period === "monthly" ? "Month end" : "Year end"} data={(data?.management?.trend ?? []).map((point) => ({ date: point.date, sales: restricted ? point.transactions : point.sales ?? 0 }))} />}
        </section>
        <section className="panel top-products"><div className="panel-header"><div><h2>Top-selling products</h2><p>By units sold · {period === "weekly" ? "this week" : period === "monthly" ? "this month" : "this year"}</p></div><button className="text-button" onClick={() => setModule("Reports")}>View report <ChevronRight size={15} /></button></div>
          {loading ? <ListSkeleton /> : data?.top_products.length ? <div className="rank-list">{data.top_products.map((item, index) => <div className="rank-row" key={item.product_id}><span className={`rank-index ${index < 3 ? "highlight" : ""}`}>{String(index + 1).padStart(2, "0")}</span><span className="rank-name">{item.name}<small>{item.quantity} units sold</small></span><span className="rank-value">{item.revenue == null ? `${item.quantity} units` : currency(item.revenue)}</span></div>)}</div> : <EmptyState title="No sales yet" body="Sales activity will appear here as your team checks out orders." />}</section>
        <section className="panel alert-panel"><div className="panel-header"><div><h2>Inventory attention</h2><p>Items requiring action</p></div><button className="icon-button" aria-label="View inventory" onClick={() => setModule("Inventory")}><ChevronRight size={17} /></button></div>
          <button className="alert-row" onClick={() => setModule("Inventory")}><span className="alert-icon amber"><AlertTriangle size={16} /></span><span><strong>Low stock items</strong><small>Below reorder threshold</small></span><b>{data?.inventory.low_stock_products ?? 0}</b><ChevronRight size={15} /></button>
          <button className="alert-row" onClick={() => setModule("Inventory")}><span className="alert-icon rose"><CalendarDays size={16} /></span><span><strong>Near expiry</strong><small>Within store alert window</small></span><b>{data?.inventory.expiring_batches ?? 0}</b><ChevronRight size={15} /></button>
          {(data?.inventory.expired_batches ?? 0) > 0 && <button className="alert-row" onClick={() => setModule("Inventory")}><span className="alert-icon red"><AlertTriangle size={16} /></span><span><strong>Expired batches</strong><small>Remove from sale immediately</small></span><b>{data?.inventory.expired_batches}</b><ChevronRight size={15} /></button>}
        </section>
        {!restricted && <section className="panel payment-panel"><div className="panel-header"><div><h2>Payment methods</h2><p>Collected today</p></div><CreditCard size={17} className="subtle-icon" /></div>
          {data?.payment_breakdown.length ? data.payment_breakdown.map((item) => {
            const total = data.payment_breakdown.reduce((sum, method) => sum + Number(method.amount), 0);
            const proportion = total ? Number(item.amount) / total * 100 : 0;
            return <div className="payment-row" key={item.method}><div><span>{item.method.replace(/_/g, " ")}</span><strong>{currency(item.amount)}</strong></div><div className="progress-track"><i style={{ width: `${proportion}%` }} /></div></div>;
          }) : <EmptyState title="No payments today" body="Payment mix will appear after your first checkout." />}
        </section>}
        <section className="panel recent-panel"><div className="panel-header"><div><h2>Recent transactions</h2><p>Latest invoices from your store</p></div><button className="text-button" onClick={() => setModule("Sales")}>All sales <ChevronRight size={15} /></button></div>
          {loading ? <ListSkeleton /> : data?.recent_transactions.length ? <div className="transactions">{data.recent_transactions.map((item) => <div className="transaction-row" key={item.id}><span className="transaction-icon"><ShoppingBag size={16} /></span><span className="transaction-name"><strong>{item.invoice_number}</strong><small>{new Date(item.created_at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</small></span><span className="status-badge success">{item.status}</span>{!restricted && <b>{currency(item.total)}</b>}</div>)}</div> : <EmptyState title="No transactions" body="Your completed sales will appear here." />}</section>
      </div>
      <div className="dashboard-bottom"><span><Check size={14} /> Data updates automatically after each transaction</span><button onClick={() => notify("Dashboard refreshed")}>Last updated just now</button></div>
    </>}
  </div>;
}

function TrendChart({ data, endLabel }: { data: Dashboard["trend"]; endLabel: string }) {
  const width = 680, height = 210, padX = 10, padY = 20;
  const max = Math.max(...data.map((item) => item.sales), 1);
  const points = data.map((item, i) => {
    const x = padX + (i / Math.max(1, data.length - 1)) * (width - padX * 2);
    const y = height - padY - (item.sales / max) * (height - padY * 2);
    return `${x},${y}`;
  }).join(" ");
  return <div className="chart-wrap"><svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Sales trend chart">
    {[0, 1, 2, 3].map((line) => <line key={line} x1="0" x2={width} y1={padY + line * 52} y2={padY + line * 52} className="chart-grid" />)}
    <defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--brand)" stopOpacity=".2" /><stop offset="100%" stopColor="var(--brand)" stopOpacity="0" /></linearGradient></defs>
    {data.length > 1 && <><polygon points={`${padX},${height - padY} ${points} ${width - padX},${height - padY}`} fill="url(#chart-fill)" /><polyline points={points} fill="none" stroke="var(--brand)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></>}
  </svg><div className="chart-labels"><span>{data[0]?.date ? new Date(`${data[0].date}T00:00:00`).toLocaleDateString("en", { month: "short", day: "numeric" }) : "—"}</span><span>{data[Math.floor(data.length / 2)]?.date ? new Date(`${data[Math.floor(data.length / 2)].date}T00:00:00`).toLocaleDateString("en", { month: "short", day: "numeric" }) : "—"}</span><span>{endLabel}</span></div></div>;
}

function useLoad<T>(path: string, enabled = true) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    if (!enabled) { setLoading(false); return; }
    setLoading(true); setError("");
    api<T>(path).then(setData).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to load data.")).finally(() => setLoading(false));
  }, [path, enabled]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

function ModulePage({ module, user, notify, refreshBillingStatus }: {
  module: Module;
  user: User;
  notify: (message: string) => void;
  refreshBillingStatus: () => void;
}) {
  if (module === "Sales") return <TablePage title="Sales history" subtitle="Search and review completed invoices." path="/api/sales" fields={["invoice_number", "status", "subtotal", "tax_total", "total", "created_at"]} />;
  if (module === "Purchases") return <PurchasesPage notify={notify} />;
  if (module === "Customers") return <DirectoryPage title="Customers" path="/api/customers" fields={["name", "phone", ...(user.role === "owner" || user.role === "admin" || user.role === "accountant" ? ["credit_limit", "opening_balance"] : [])]} createPath="/api/customers" formFields={["name", "phone", "address", ...(user.role === "owner" || user.role === "admin" || user.role === "accountant" ? ["credit_limit"] : [])]} notify={notify} />;
  if (module === "Suppliers") return <DirectoryPage title="Suppliers" path="/api/suppliers" fields={["name", "contact_name", "phone", "email"]} createPath="/api/suppliers" formFields={["name", "contact_name", "phone", "email", "address"]} notify={notify} />;
  if (module === "Accounting") return <AccountingPage role={user.role} notify={notify} />;
  if (module === "Expenses") return <ExpensesPage notify={notify} />;
  if (module === "Credit accounts") return <CreditAccountsPage role={user.role} notify={notify} />;
  if (module === "Reports") return <ReportsPage />;
  if (module === "Users & access") return <UsersPage role={user.role} notify={notify} />;
  if (module === "Operating guide") return <OperatingGuide role={user.role} />;
  if (module === "Subscription") return <SubscriptionPage role={user.role} notify={notify} refreshStatus={refreshBillingStatus} />;
  return <SettingsPage role={user.role} notify={notify} />;
}

function InventoryPage({ notify, initialSearch }: { notify: (message: string) => void; initialSearch: string }) {
  const { data: products, error, loading, reload } = useLoad<Product[]>("/api/products");
  const { data: suppliers } = useLoad<Supplier[]>("/api/suppliers");
  const { data: batches, reload: reloadBatches } = useLoad<Row[]>("/api/batches?include_empty=true");
  const [search, setSearch] = useState(initialSearch);
  const [form, setForm] = useState<"product" | "receipt" | "adjustment" | null>(null);
  const [barcode, setBarcode] = useState("");
  const filtered = useMemo(() => (products ?? []).filter((item) => [item.name, item.generic_name, item.sku, item.barcode].join(" ").toLowerCase().includes(search.toLowerCase())), [products, search]);
  useEffect(() => { setSearch(initialSearch); }, [initialSearch]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
    try { await post<Product>("/api/products", { ...data, pack_size: Number(data.pack_size), purchase_price: Number(data.purchase_price), sale_price: Number(data.sale_price), tax_rate: Number(data.tax_rate), reorder_level: Number(data.reorder_level) }); notify("Product created"); setForm(null); reload(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : "Could not create product."); }
  }
  async function receive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await post("/api/batches/receive", { ...data, quantity: Number(data.quantity), purchase_price: Number(data.purchase_price), supplier_id: data.supplier_id || null });
      notify("Stock received"); setForm(null); reload(); reloadBatches();
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not receive stock."); }
  }
  async function adjust(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await post("/api/inventory/adjustments", { ...data, quantity: Number(data.quantity) });
      notify("Stock adjustment recorded"); setForm(null); reload(); reloadBatches();
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not adjust stock."); }
  }
  const scan = () => { if (barcode.trim()) { setSearch(barcode.trim()); setBarcode(""); } };
  return <div className="page-stack"><PageTitle title="Inventory" subtitle="Manage products, batches, stock levels, and expiry." action={<><button className="button secondary" onClick={() => setForm(form === "adjustment" ? null : "adjustment")}><Activity size={15} />Adjust stock</button><button className="button secondary" onClick={() => setForm(form === "receipt" ? null : "receipt")}><Package size={15} />Receive stock</button><button className="button primary" onClick={() => setForm(form === "product" ? null : "product")}><Plus size={16} />Add product</button></>} />
    {form === "product" && <form className="form-panel product-form" onSubmit={create}><h2>Product details</h2><div className="form-grid">{[
      ["sku", "SKU", true], ["name", "Product name", true], ["generic_name", "Generic name", false], ["category", "Category", false], ["manufacturer", "Manufacturer", false], ["barcode", "Barcode", false], ["unit", "Selling unit", true], ["pack_size", "Pack size", true], ["purchase_price", "Purchase price", true], ["sale_price", "Sale price", true], ["tax_rate", "Tax rate %", true], ["reorder_level", "Reorder level", true], ["shelf_location", "Shelf location", false],
    ].map(([name, label, required]) => <label key={String(name)}>{String(label)}<input name={String(name)} required={Boolean(required)} type={["pack_size", "purchase_price", "sale_price", "tax_rate", "reorder_level"].includes(String(name)) ? "number" : "text"} step="any" defaultValue={["unit", "pack_size", "purchase_price", "sale_price", "tax_rate", "reorder_level"].includes(String(name)) ? ({ unit: "pack", pack_size: 1, purchase_price: 0, sale_price: 0, tax_rate: 0, reorder_level: 0 } as Record<string, number | string>)[String(name)] : ""} /></label>)}</div><FormActions cancel={() => setForm(null)} submit="Save product" /></form>}
    {form === "receipt" && <form className="form-panel" onSubmit={receive}><h2>Receive stock</h2><p className="subtle">Record a batch with an expiry date for FEFO dispensing.</p><div className="form-grid"><label>Product<select name="product_id" required><option value="">Choose product</option>{products?.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label><label>Batch number<input name="batch_number" required /></label><label>Expiry date<input name="expiry_date" type="date" required /></label><label>Quantity<input name="quantity" type="number" min=".001" step=".001" required /></label><label>Purchase price<input name="purchase_price" type="number" min="0" step=".01" required /></label><label>Supplier<select name="supplier_id"><option value="">Opening stock / no supplier</option>{suppliers?.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label><label>Reference<input name="reference" /></label></div><FormActions cancel={() => setForm(null)} submit="Record receipt" /></form>}
    {form === "adjustment" && <form className="form-panel" onSubmit={adjust}><h2>Stock adjustment</h2><p className="subtle">Adjustments are recorded in the stock movement and audit history.</p><div className="form-grid"><label>Batch<select name="batch_id" required><option value="">Choose batch</option>{batches?.map((batch) => <option key={String(batch.id)} value={String(batch.id)}>{products?.find((product) => product.id === batch.product_id)?.name ?? String(batch.product_id)} · {String(batch.batch_number)} · {String(batch.quantity)} on hand</option>)}</select></label><label>Direction<select name="direction"><option value="remove">Remove stock</option><option value="add">Add stock</option></select></label><label>Quantity<input name="quantity" type="number" min=".001" step=".001" required /></label><label>Reason<select name="reason_code" required>{["damage", "expiry write-off", "manual stock correction", "supplier return", "other"].map((reason) => <option key={reason} value={reason}>{reason}</option>)}</select></label><label>Notes<input name="notes" /></label></div><FormActions cancel={() => setForm(null)} submit="Save adjustment" /></form>}
    <section className="panel table-panel"><div className="table-toolbar"><div className="table-search"><Search size={16} /><input placeholder="Search product, SKU or barcode..." value={search} onChange={(e) => setSearch(e.target.value)} /></div><div className="toolbar-right"><div className="scan-input"><Command size={15} /><input placeholder="Scan barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); scan(); } }} /><button onClick={scan} type="button">Find</button></div><button className="button secondary small" onClick={() => api<unknown>("/api/inventory/movements").then(() => notify("Stock movements loaded")).catch((e: Error) => notify(e.message))}><FileClock size={15} />Movements</button></div></div>
      {error ? <ErrorPanel message={error} onRetry={reload} /> : loading ? <TableSkeleton /> : <DataTable rows={filtered as unknown as Row[]} fields={["sku", "name", "category", "unit", "stock", "reorder_level", "sale_price", "shelf_location"]} labels={{sku:"SKU", name:"Product", category:"Category", unit:"Unit", stock:"On hand", reorder_level:"Reorder at", sale_price:"Sale price", shelf_location:"Location"}} empty="No products found." />}
      <div className="table-foot"><span>{filtered.length} products</span><button onClick={() => exportCsv(filtered as unknown as Row[], "inventory.csv")}>Export CSV</button></div>
    </section>
  </div>;
}

function POSPage({ notify }: { notify: (message: string) => void }) {
  const { data: products, loading, error, reload } = useLoad<Product[]>("/api/products");
  const { data: customers } = useLoad<Customer[]>("/api/customers");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Product[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [customerId, setCustomerId] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [prescriptionReference, setPrescriptionReference] = useState("");
  const [method, setMethod] = useState("cash");
  const [working, setWorking] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<{ href: string; invoice: string } | null>(null);
  const checkoutRequest = useRef<{ body: string; key: string } | null>(null);
  const matches = (products ?? []).filter((p) => [p.name, p.sku, p.barcode, p.generic_name].join(" ").toLowerCase().includes(query.toLowerCase()) && query.length > 0).slice(0, 8);
  const total = selected.reduce((sum, p) => {
    const gross = roundMoney(p.sale_price * (qty[p.id] ?? 1));
    return sum + gross + roundMoney(gross * p.tax_rate / 100);
  }, 0);
  function add(product: Product) { setSelected((current) => current.some((p) => p.id === product.id) ? current : [...current, product]); setQty((current) => ({ ...current, [product.id]: (current[product.id] ?? 0) + 1 })); setQuery(""); }
  async function checkout() {
    if (!selected.length) { notify("Add at least one product to the sale."); return; }
    setLastReceipt(null);
    setWorking(true);
    try {
      const request = {
        customer_id: customerId || null,
        lines: selected.map((p) => ({ product_id: p.id, quantity: qty[p.id] ?? 1, discount: 0 })),
        payments: [{ method, amount: Number(total.toFixed(2)), reference: "" }],
        prescription_reference: prescriptionReference,
      };
      const body = JSON.stringify(request);
      if (checkoutRequest.current?.body !== body) checkoutRequest.current = { body, key: crypto.randomUUID() };
      const sale = await post<{
        invoice_number: string; total: number; tax_total: number;
        lines: { product_name: string; quantity: number; unit_price: number; discount: number }[];
      }>("/api/sales", request, { "Idempotency-Key": checkoutRequest.current.key });
      checkoutRequest.current = null;
      const receiptText = [
        `Receipt from ${localStorage.getItem("erp-store-name") ?? "our pharmacy"}`,
        `Invoice: ${sale.invoice_number}`,
        ...sale.lines.map((line) => `${line.product_name} x ${line.quantity} - ${receiptCurrency(roundMoney(line.unit_price * line.quantity - line.discount))}`),
        `Tax: ${receiptCurrency(sale.tax_total)}`,
        `Total: ${receiptCurrency(sale.total)}`,
        "Thank you for your purchase.",
      ].join("\n");
      const receiptLink = whatsappLink(customerPhone, receiptText);
      setLastReceipt(receiptLink ? { href: receiptLink, invoice: sale.invoice_number } : null);
      notify(receiptLink ? "Sale completed. The receipt is ready to review on WhatsApp." : "Sale completed successfully.");
      setSelected([]); setQty({}); setCustomerId(""); setCustomerPhone(""); setPrescriptionReference(""); reload();
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Unable to complete sale."); }
    finally { setWorking(false); }
  }
  return <div className="page-stack"><PageTitle title="Point of sale" subtitle="Scan products, build a cart, and take payment." action={<span className="tag tag-neutral"><Command size={14} />Barcode ready</span>} />
    {error && <ErrorPanel message={error} onRetry={reload} />}
    <div className="pos-layout"><section className="panel product-picker"><div className="pos-search"><Search size={19} /><input autoFocus placeholder="Search name, SKU or scan barcode..." value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) add(matches[0]); }} /></div>
      <div className="pos-products">{loading ? <ListSkeleton /> : matches.length ? matches.map((item) => <button className="pos-product" key={item.id} onClick={() => add(item)}><span className="product-tile"><Package size={19} /></span><span><strong>{item.name}</strong><small>{item.sku} · {item.stock} in stock</small></span><b>{currency(item.sale_price)}</b><Plus size={17} /></button>) : <EmptyState title={query ? "No matching products" : "Start a sale"} body={query ? "Try another name, SKU, or barcode." : "Search for a product or scan its barcode to add it."} />}</div>
    </section><section className="panel cart-panel"><div className="panel-header"><div><h2>Current sale</h2><p>{selected.length} line items</p></div><ShoppingCart size={18} className="subtle-icon" /></div>
      <label className="field-label">Customer<select value={customerId} onChange={(e) => { const id = e.target.value; setCustomerId(id); setCustomerPhone(customers?.find((customer) => customer.id === id)?.phone ?? ""); }}><option value="">Walk-in customer</option>{customers?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.phone ?? "No phone"}</option>)}</select></label>
      <label className="field-label">Customer phone for WhatsApp receipt<input type="tel" autoComplete="tel" placeholder="e.g. +92 300 1234567" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} /><small>Optional. WhatsApp opens a receipt draft for you to review and send.</small></label>
      <label className="field-label">Prescription reference (optional)<input value={prescriptionReference} onChange={(event) => setPrescriptionReference(event.target.value)} placeholder="Prescription or doctor reference" /></label>
      <div className="cart-lines">{selected.length ? selected.map((p) => <div className="cart-line" key={p.id}><div><strong>{p.name}</strong><small>{currency(p.sale_price)} / {p.unit}</small></div><input aria-label={`Quantity for ${p.name}`} type="number" min="0.001" step="0.001" value={qty[p.id] ?? 1} onChange={(e) => setQty({ ...qty, [p.id]: Number(e.target.value) })} /><b>{currency(p.sale_price * (qty[p.id] ?? 1))}</b><button className="icon-button danger-icon" onClick={() => setSelected(selected.filter((item) => item.id !== p.id))} aria-label={`Remove ${p.name}`}><X size={16} /></button></div>) : <EmptyState title="Cart is empty" body="Products you add will appear here." />}</div>
      <div className="checkout"><label className="field-label">Payment method<select value={method} onChange={(e) => setMethod(e.target.value)}>{["cash", "card", "mobile_wallet", "credit"].map((item) => <option key={item} value={item}>{item.replace("_", " ")}</option>)}</select></label><div className="total-line"><span>Total due</span><strong>{currency(total)}</strong></div><button className="button primary full" disabled={working || !selected.length} onClick={checkout}>{working ? "Processing..." : "Complete sale"}<ChevronRight size={17} /></button></div>
      {lastReceipt && <a className="button secondary full receipt-link" href={lastReceipt.href} target="_blank" rel="noopener noreferrer"><MessageCircle size={16} />Send {lastReceipt.invoice} receipt on WhatsApp</a>}
    </section></div></div>;
}

function PurchasesPage({ notify }: { notify: (message: string) => void }) {
  const { data, error, loading, reload } = useLoad<Row[]>("/api/purchases");
  const { data: suppliers } = useLoad<Supplier[]>("/api/suppliers");
  const [open, setOpen] = useState(false);
  const [receiving, setReceiving] = useState<{ id: string; purchase_number: string } | null>(null);
  const { data: receiveLines, reload: reloadReceiveLines } = useLoad<Row[]>(
    receiving ? `/api/purchases/${receiving.id}/lines` : "/api/purchases",
    Boolean(receiving),
  );
  const { data: products } = useLoad<Product[]>("/api/products");
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const d = Object.fromEntries(new FormData(event.currentTarget));
    try { await post("/api/purchases", { supplier_id: d.supplier_id, supplier_invoice: d.supplier_invoice, due_date: d.due_date || null, lines: [{ product_id: d.product_id, batch_number: d.batch_number, expiry_date: d.expiry_date, quantity_ordered: Number(d.quantity_ordered), unit_cost: Number(d.unit_cost) }] }); notify("Purchase order created"); setOpen(false); reload(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : "Could not create purchase."); }
  }
  async function receiveLine(line: Row) {
    if (!receiving) return;
    const remaining = Number(line.quantity_ordered) - Number(line.quantity_received);
    const raw = window.prompt(`Quantity received (up to ${remaining})`, String(remaining));
    if (raw === null) return;
    const quantity = Number(raw);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > remaining) {
      notify("Enter a quantity greater than zero and no more than the remaining order quantity.");
      return;
    }
    try {
      await post(`/api/purchases/${receiving.id}/receive`, { line_id: line.id, quantity });
      notify("Stock receipt recorded");
      reload();
      reloadReceiveLines();
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not receive order."); }
  }
  return <div className="page-stack"><PageTitle title="Purchases & receiving" subtitle="Create supplier orders and record goods received." action={<button className="button primary" onClick={() => setOpen(!open)}><Plus size={16} />New purchase order</button>} />
    {open && <form className="form-panel" onSubmit={create}><h2>Purchase order details</h2><div className="form-grid"><label>Supplier<select name="supplier_id" required><option value="">Select supplier</option>{suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>Supplier invoice<input name="supplier_invoice" /></label><label>Product<select name="product_id" required><option value="">Select product</option>{products?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Batch number<input name="batch_number" required /></label><label>Expiry date<input name="expiry_date" type="date" required /></label><label>Quantity<input name="quantity_ordered" type="number" min="0.001" step="0.001" required /></label><label>Unit cost<input name="unit_cost" type="number" min="0" step=".01" required /></label><label>Due date<input name="due_date" type="date" /></label></div><FormActions cancel={() => setOpen(false)} submit="Create order" /></form>}
    {receiving && <section className="panel receiving-panel"><div className="panel-header"><div><h2>Receive {receiving.purchase_number}</h2><p>Confirm delivered quantities; received stock is available to sell immediately.</p></div><button className="icon-button" aria-label="Close receiving details" onClick={() => setReceiving(null)}><X size={17} /></button></div>{receiveLines?.map((line) => <div className="receive-line" key={String(line.id)}><span><strong>{String(line.product_name ?? line.batch_number)}</strong><small>Batch {String(line.batch_number)} · expires {String(line.expiry_date)}</small></span><span>{String(line.quantity_received)} / {String(line.quantity_ordered)} received</span><button className="button secondary small" disabled={Number(line.quantity_received) >= Number(line.quantity_ordered)} onClick={() => receiveLine(line)}>Receive</button></div>)}</section>}
    <section className="panel table-panel">{error ? <ErrorPanel message={error} onRetry={reload} /> : loading ? <TableSkeleton /> : <DataTable rows={data ?? []} fields={["purchase_number", "supplier_invoice", "status", "subtotal", "tax_total", "total", "due_date", "created_at"]} labels={{purchase_number:"Order", supplier_invoice:"Supplier invoice", status:"Status", subtotal:"Subtotal", tax_total:"Tax", total:"Total", due_date:"Due date", created_at:"Created"}} actions={(row) => <button className="text-button" onClick={() => setReceiving({ id: String(row.id), purchase_number: String(row.purchase_number) })}>Receive stock</button>} />}
      <div className="table-foot"><span>{data?.length ?? 0} purchase orders</span><button onClick={() => exportCsv(data ?? [], "purchases.csv")}>Export CSV</button></div></section>
  </div>;
}

function DirectoryPage({ title, path, fields, createPath, formFields, notify }: {
  title: string; path: string; fields: string[]; createPath: string; formFields: string[]; notify: (message: string) => void;
}) {
  const { data, error, loading, reload } = useLoad<Row[]>(path);
  const [open, setOpen] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget));
    try { await post(createPath, form); notify(`${title.slice(0, -1)} created`); setOpen(false); reload(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : "Unable to save record."); }
  }
  return <div className="page-stack"><PageTitle title={title} subtitle={`Maintain your ${title.toLowerCase()} directory and account information.`} action={<button className="button primary" onClick={() => setOpen(!open)}><Plus size={16} />Add {title.slice(0, -1).toLowerCase()}</button>} />
    {open && <form className="form-panel" onSubmit={create}><h2>Contact information</h2><div className="form-grid">{formFields.map((field) => <label key={field}>{field.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}<input name={field} required={field === "name"} type={field === "email" ? "email" : "text"} /></label>)}</div><FormActions cancel={() => setOpen(false)} submit="Save contact" /></form>}
    <section className="panel table-panel">{error ? <ErrorPanel message={error} onRetry={reload} /> : loading ? <TableSkeleton /> : <DataTable rows={data ?? []} fields={fields} empty={`No ${title.toLowerCase()} have been added yet.`} />}</section>
  </div>;
}

function TablePage({ title, subtitle, path, fields }: { title: string; subtitle: string; path: string; fields: string[] }) {
  const { data, error, loading, reload } = useLoad<Row[]>(path);
  return <div className="page-stack"><PageTitle title={title} subtitle={subtitle} action={<button className="button secondary" onClick={() => exportCsv(data ?? [], "sales.csv")}><FileBarChart size={16} />Export CSV</button>} /><section className="panel table-panel">{error ? <ErrorPanel message={error} onRetry={reload} /> : loading ? <TableSkeleton /> : <DataTable rows={data ?? []} fields={fields} empty="No sales yet. Completed invoices will appear here." />}</section></div>;
}

type CreditInvoice = {
  invoice_number?: string;
  purchase_number?: string;
  date: string;
  credit_amount?: number;
  received_amount?: number;
  outstanding: number;
  status?: string;
  items: { name: string; quantity: number }[];
};
type CreditParty = {
  id: string;
  name: string;
  phone: string | null;
  balance: number;
  credit_limit?: number;
  unallocated_balance: number;
  credit_sales?: CreditInvoice[];
  open_purchases?: CreditInvoice[];
};

function whatsappLink(phone: string, message: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith("3")) digits = `92${digits}`;
  return digits.length >= 10 ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;
}

function CreditAccountsPage({ role, notify }: { role: string; notify: (message: string) => void }) {
  const { data, error, loading, reload } = useLoad<{ customers: CreditParty[]; suppliers: CreditParty[] }>("/api/credit-balances");
  const [tab, setTab] = useState<"customers" | "suppliers">("customers");
  const [working, setWorking] = useState("");
  const [paymentTarget, setPaymentTarget] = useState<{ party: CreditParty; kind: "customers" | "suppliers" } | null>(null);
  const [paymentError, setPaymentError] = useState("");
  const parties = data?.[tab] ?? [];
  const owner = role === "owner";

  async function recordPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!paymentTarget) return;
    const { party, kind } = paymentTarget;
    const rawAmount = new FormData(event.currentTarget).get("amount");
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > party.balance) {
      setPaymentError(`Enter an amount greater than zero and no more than ${currency(party.balance)}.`);
      return;
    }
    setPaymentError("");
    setWorking(party.id);
    try {
      await post(`/api/${kind}/${party.id}/payments`, {
        amount,
        method: "cash",
        reference: "",
        description: `Balance payment recorded from ${party.name}`,
      });
      notify(`Payment recorded for ${party.name}.`);
      setPaymentTarget(null);
      reload();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to record payment.";
      setPaymentError(message);
      notify(message);
    } finally {
      setWorking("");
    }
  }

  const whatsapp = (party: CreditParty, supplier: boolean) => whatsappLink(
    party.phone ?? "",
    supplier
      ? `Hello ${party.name}, our records show an outstanding payable of ${currency(party.balance)} from ${localStorage.getItem("erp-store-name") ?? "our pharmacy"}. Please contact us to coordinate settlement. If payment is already arranged, please ignore this reminder. Thank you.`
      : `Hello ${party.name}, our records show an outstanding pharmacy balance of ${currency(party.balance)} for purchases on credit. Kindly settle it when convenient. If you have already paid, please ignore this reminder. Thank you.`,
  );

  return <div className="page-stack">
    <PageTitle title="Credit accounts" subtitle="Review customer udhaar, supplier payables, and recorded credit transactions." action={<button className="button secondary" onClick={reload}><Activity size={16} />Refresh</button>} />
    <div className="quick-actions">
      <button className={tab === "customers" ? "active" : ""} onClick={() => setTab("customers")}><Users size={17} /><span>Customer udhaar · {data?.customers.length ?? 0}</span><ChevronRight size={15} /></button>
      <button className={tab === "suppliers" ? "active" : ""} onClick={() => setTab("suppliers")}><Building2 size={17} /><span>Supplier payables · {data?.suppliers.length ?? 0}</span><ChevronRight size={15} /></button>
    </div>
    {error ? <ErrorPanel message={error} onRetry={reload} /> : loading ? <ListSkeleton /> : parties.length === 0
      ? <section className="panel"><EmptyState title={tab === "customers" ? "No customer balances due" : "No supplier balances due"} body="Outstanding balances will appear here when credit sales or received supplier stock are recorded." /></section>
      : <div className="credit-list">{parties.map((party) => {
        const supplier = tab === "suppliers";
        const invoices = supplier ? party.open_purchases ?? [] : party.credit_sales ?? [];
        const link = whatsapp(party, supplier);
        return <section className="panel credit-card" key={party.id}>
          <div className="panel-header"><div><h2>{party.name}</h2><p>{party.phone || "No phone number"}{party.credit_limit != null ? ` · Credit limit ${currency(party.credit_limit)}` : ""}</p></div><strong className="credit-balance">{currency(party.balance)}</strong></div>
          {party.unallocated_balance > 0 && <p className="subtle">Unallocated/opening balance: {currency(party.unallocated_balance)}.</p>}
          {invoices.length > 0 && <div className="credit-invoices">{invoices.map((invoice) => <div className="credit-invoice" key={invoice.invoice_number ?? invoice.purchase_number}>
            <span><strong>{invoice.invoice_number ?? invoice.purchase_number}</strong><small>{new Date(invoice.date).toLocaleDateString("en", { dateStyle: "medium" })} · {(invoice.items ?? []).map((item) => `${item.name} × ${item.quantity}`).join(", ")}</small></span>
            <span><strong>{currency(invoice.outstanding)}</strong><small>{supplier ? "Outstanding" : "Credit portion outstanding"}</small></span>
          </div>)}</div>}
          <div className="credit-actions">
            {link ? <a className="button secondary small" href={link} target="_blank" rel="noopener noreferrer"><MessageCircle size={15} />{supplier ? "WhatsApp supplier" : "WhatsApp reminder"}</a> : <span className="subtle">Add a valid phone number to enable WhatsApp reminders.</span>}
            {owner && <button className="button primary small" disabled={working === party.id} onClick={() => { setPaymentError(""); setPaymentTarget({ party, kind: tab }); }}><Banknote size={15} />Record payment</button>}
          </div>
          {paymentTarget?.party.id === party.id && <form className="credit-payment-form" onSubmit={(event) => void recordPayment(event)}>
            <label>Payment amount (PKR)
              <input name="amount" type="number" min="0.01" max={party.balance} step="0.01" defaultValue={Number(party.balance).toFixed(2)} required disabled={working === party.id} />
            </label>
            {paymentError && <p className="credit-payment-error" role="alert">{paymentError}</p>}
            <div className="form-actions">
              <button className="button secondary small" type="button" disabled={working === party.id} onClick={() => setPaymentTarget(null)}>Cancel</button>
              <button className="button primary small" type="submit" disabled={working === party.id}><Banknote size={15} />{working === party.id ? "Saving..." : "Save payment"}</button>
            </div>
          </form>}
        </section>;
      })}</div>}
    <p className="subtle">Payments recorded here change the ledger balance. Invoice-level outstanding amounts are allocated oldest-first; verify statements with your customer or supplier.</p>
  </div>;
}

function OperatingGuide({ role }: { role: string }) {
  const isOwner = role === "owner";
  return <div className="page-stack">
    <PageTitle title="ERP operating guide" subtitle="A practical checklist for safe day-to-day pharmacy operations." />
    <section className="panel guide-intro"><BookOpen size={22} /><div><strong>{isOwner ? "Owner guide · full financial and administration access" : `Staff guide · ${role} access`}</strong><p>Use your own account; never share the pharmacy owner's password. Your role controls which financial and administration screens are available.</p></div></section>
    <div className="guide-grid">
      <article className="panel guide-card"><span className="guide-step">00</span><h2>Three separate access layers</h2><ol><li><strong>MedFlow masterboard:</strong> reserved for Syed Hashir Ali to provision pharmacies, manage subscriptions, and review each store's daily sales, stock alerts, and balances.</li><li><strong>Pharmacy owner:</strong> each pharmacy has its own private workspace; its owner sees that store's financials and manages its settings and staff.</li><li><strong>Pharmacy staff:</strong> the owner assigns cashier, pharmacist, manager, or accountant accounts with only the permissions their role needs.</li></ol></article>
      <article className="panel guide-card"><span className="guide-step">01</span><h2>Set up the pharmacy</h2><ol><li>Owner: complete the store profile, currency, tax rate, invoice prefix, and expiry alert window in Settings.</li><li>Add suppliers and customers with accurate phone numbers; authorized finance users set credit limits and opening balances.</li><li>Owner: create individual staff accounts in Users & access and assign only the role needed for each job.</li></ol></article>
      <article className="panel guide-card"><span className="guide-step">02</span><h2>Build inventory and receive stock</h2><ol><li>In Inventory, create products with SKU/barcode, generic name, unit, sale price, tax, reorder level, and shelf location.</li><li>Record a stock receipt with its real batch number, expiry date, purchase cost, and supplier.</li><li>Check low-stock and expiry alerts daily; use the adjustment workflow for damage or write-offs so the audit trail stays complete.</li></ol></article>
      <article className="panel guide-card"><span className="guide-step">03</span><h2>Make a sale</h2><ol><li>Open Point of sale, scan a barcode or search for a product, review quantity and the selected customer.</li><li>Choose the actual tender method. Credit/udhaar requires a registered customer and respects the credit limit.</li><li>Complete the sale only after confirming the total and payment. The system deducts eligible unexpired stock using FEFO.</li></ol></article>
      <article className="panel guide-card"><span className="guide-step">04</span><h2>Track udhaar and suppliers</h2><ol><li>Authorized finance users open Credit accounts to review customer balances and supplier amounts owed.</li><li>Check invoice and item details before recording a payment; every entry affects the ledger.</li><li>WhatsApp buttons open a draft message with the balance. Review it and press Send yourself; the ERP does not send messages automatically.</li></ol></article>
      <article className="panel guide-card"><span className="guide-step">05</span><h2>Daily expenses and management</h2><ol><li>Record rent, utilities, wages, delivery, refrigeration, and petty cash in Shop expenses on the day they are paid.</li><li>Use weekly, monthly, yearly, or custom date ranges to review sales, gross profit, expenses, and cash/bank totals.</li><li>At checkout, enter a customer phone to prepare an itemized WhatsApp receipt; review the draft and press Send in WhatsApp.</li></ol></article>
      <article className="panel guide-card"><span className="guide-step">06</span><h2>Review and protect the system</h2><ol><li>Owner reviews Dashboard, dated sales and expense reports, receivables, payables, and audit activity.</li><li>Staff use their own login. Do not use or disclose the owner's password; change temporary passwords promptly.</li><li>Back up the database regularly and test restoring a copy before relying on the system for real operations.</li></ol></article>
      <article className="panel guide-card"><span className="guide-step">07</span><h2>Current demo boundaries</h2><ol><li>The local demo starts with sample data and is for evaluation, not live pharmacy records.</li><li>WhatsApp is a click-to-chat draft, not an official WhatsApp Business API integration; a person must send it.</li><li>Returns/refunds and installable multi-PC/LAN/VPN operation are not yet implemented.</li></ol></article>
    </div>
  </div>;
}

type DateRange = { start: string; end: string };
type ExpensePeriod = "today" | "weekly" | "monthly" | "yearly" | "custom";

function defaultDateRange(period: Exclude<ExpensePeriod, "custom">): DateRange {
  const end = new Date();
  const start = new Date(end);
  if (period === "weekly") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (period === "monthly") start.setDate(1);
  if (period === "yearly") { start.setMonth(0, 1); }
  return { start: localDateInput(start), end: localDateInput(end) };
}

function localDateInput(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function ExpensesPage({ notify }: { notify: (message: string) => void }) {
  const [period, setPeriod] = useState<ExpensePeriod>("today");
  const [range, setRange] = useState<DateRange>(() => defaultDateRange("today"));
  const [formOpen, setFormOpen] = useState(false);
  const query = new URLSearchParams({ start_date: range.start, end_date: range.end, timezone_name: browserTimezone() }).toString();
  const { data, error, loading, reload } = useLoad<Row[]>(`/api/expenses?${query}`);
  const expenses = data ?? [];
  const total = expenses.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const cash = expenses.filter((row) => row.payment_method === "cash").reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const bank = total - cash;

  function choosePeriod(next: ExpensePeriod) {
    setPeriod(next);
    if (next !== "custom") setRange(defaultDateRange(next));
  }

  async function createExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await post("/api/expenses", { ...values, amount: Number(values.amount) });
      notify("Shop expense recorded.");
      setFormOpen(false);
      reload();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Unable to record shop expense.");
    }
  }

  return <div className="page-stack">
    <PageTitle title="Shop expenses" subtitle="Record and review daily pharmacy operating costs and petty cash." action={<><button className="button secondary" onClick={() => exportCsv(expenses, "shop-expenses.csv")}><FileBarChart size={16} />Export CSV</button><button className="button primary" onClick={() => setFormOpen((open) => !open)}><Plus size={16} />Record expense</button></>} />
    <section className="panel expense-filters">
      <div className="period-switch" role="group" aria-label="Expense date range">{(["today", "weekly", "monthly", "yearly", "custom"] as const).map((option) => <button key={option} className={period === option ? "active" : ""} aria-pressed={period === option} onClick={() => choosePeriod(option)}>{option === "today" ? "Today" : option === "custom" ? "Custom range" : `This ${option.slice(0, -2)}`}</button>)}</div>
      {period === "custom" && <div className="date-range-fields"><label>From<input type="date" required value={range.start} max={range.end} onChange={(event) => setRange((current) => ({ ...current, start: event.target.value }))} /></label><label>To<input type="date" required value={range.end} min={range.start} onChange={(event) => setRange((current) => ({ ...current, end: event.target.value }))} /></label></div>}
      <span className="subtle">Showing {range.start} to {range.end}</span>
    </section>
    {formOpen && <form className="form-panel" onSubmit={(event) => void createExpense(event)}><h2>Record a shop expense</h2><p className="subtle">Expense entries are included in cash/bank ledgers and the management summary.</p><div className="form-grid">
      <label>Category<select name="category" required defaultValue=""><option value="" disabled>Select a category</option>{["Rent", "Utilities", "Staff salaries", "Delivery", "Packaging", "Cleaning supplies", "Refrigeration", "Repairs & maintenance", "Bank charges", "Other"].map((category) => <option key={category}>{category}</option>)}</select></label>
      <label>Description<input name="description" required maxLength={240} placeholder="What was paid for?" /></label>
      <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
      <label>Paid from<select name="payment_method" defaultValue="cash"><option value="cash">Cash</option><option value="bank">Bank</option><option value="card">Card</option></select></label>
    </div><FormActions cancel={() => setFormOpen(false)} submit="Save expense" /></form>}
    <div className="metric-grid small-metrics">
      <div className="metric-card"><span className="metric-top">Total expenses</span><div className="metric-value compact">{error ? "Unavailable" : loading ? "Loading..." : currency(total)}</div></div>
      <div className="metric-card"><span className="metric-top">Cash paid</span><div className="metric-value compact">{error ? "Unavailable" : loading ? "Loading..." : currency(cash)}</div></div>
      <div className="metric-card"><span className="metric-top">Bank / card</span><div className="metric-value compact">{error ? "Unavailable" : loading ? "Loading..." : currency(bank)}</div></div>
      <div className="metric-card"><span className="metric-top">Expense entries</span><div className="metric-value compact">{error ? "Unavailable" : loading ? "…" : String(expenses.length)}</div></div>
    </div>
    <section className="panel table-panel">
      <div className="panel-header"><div><h2>Expense entries</h2><p>Operating expenses for the selected period</p></div><button className="text-button" onClick={reload}>Refresh<ChevronRight size={15} /></button></div>
      {error ? <ErrorPanel message={error} onRetry={reload} /> : loading ? <TableSkeleton /> : <DataTable rows={expenses} fields={["category", "description", "amount", "payment_method", "created_at"]} empty="No expenses recorded for this period." labels={{ category: "Category", description: "Description", amount: "Amount", payment_method: "Paid by", created_at: "Date & time" }} />}
    </section>
  </div>;
}

function AccountingPage({ role, notify }: { role: string; notify: (message: string) => void }) {
  const permitted = ["owner", "admin", "accountant"].includes(role);
  const { data, error, loading, reload } = useLoad<{ entries: Row[]; account_balances: Record<string, number> }>("/api/ledger", permitted);
  const { data: shifts, reload: reloadShifts } = useLoad<Row[]>("/api/cash/shifts");
  const { data: expenses, reload: reloadExpenses } = useLoad<Row[]>("/api/expenses", permitted);
  const [form, setForm] = useState<"journal" | "expense" | "shift" | null>(null);
  async function journal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const d = Object.fromEntries(new FormData(event.currentTarget));
    try { await post("/api/ledger/journals", { description: d.description, reference: d.reference, lines: [{ account: d.debit_account, debit: Number(d.amount), credit: 0 }, { account: d.credit_account, debit: 0, credit: Number(d.amount) }] }); notify("Journal entry recorded"); setForm(null); reload(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : "Unable to record journal."); }
  }
  async function expense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const d = Object.fromEntries(new FormData(event.currentTarget));
    try { await post("/api/expenses", { ...d, amount: Number(d.amount) }); notify("Expense recorded"); setForm(null); reload(); reloadExpenses(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : "Unable to record expense."); }
  }
  async function openShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const d = Object.fromEntries(new FormData(event.currentTarget));
    try { await post("/api/cash/shifts/open", { opening_cash: Number(d.opening_cash), notes: d.notes }); notify("Register opened"); setForm(null); reloadShifts(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : "Unable to open register."); }
  }
  async function closeShift(shift: Row) {
    const raw = window.prompt("Enter the actual closing cash count");
    if (raw === null) return;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0) { notify("Enter a valid cash count."); return; }
    try {
      const result = await post<Row>(`/api/cash/shifts/${String(shift.id)}/close`, { actual_closing_cash: amount, notes: "" });
      notify(`Register closed · variance ${currency(Number(result.variance))}`);
      reloadShifts();
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Unable to close register."); }
  }
  return <div className="page-stack"><PageTitle title={permitted ? "General ledger & cash" : "Cash register"} subtitle={permitted ? "Review balances, manage register shifts, and record financial activity." : "Open and reconcile your cashier shift."} action={<><button className="button secondary" onClick={() => setForm(form === "shift" ? null : "shift")}><Banknote size={15} />Open register</button>{permitted && <><button className="button secondary" onClick={() => setForm(form === "expense" ? null : "expense")}><Plus size={15} />New expense</button><button className="button primary" onClick={() => setForm(form === "journal" ? null : "journal")}><Plus size={16} />Journal entry</button></>}</>} />
    {form === "journal" && permitted && <form className="form-panel" onSubmit={journal}><h2>Manual journal entry</h2><p className="subtle">Every journal is validated to balance before saving.</p><div className="form-grid"><label>Description<input name="description" required /></label><label>Reference<input name="reference" /></label><label>Debit account<input name="debit_account" required /></label><label>Credit account<input name="credit_account" required /></label><label>Amount<input type="number" name="amount" min=".01" step=".01" required /></label></div><FormActions cancel={() => setForm(null)} submit="Post journal" /></form>}
    {form === "expense" && permitted && <form className="form-panel" onSubmit={expense}><h2>Record an expense</h2><div className="form-grid"><label>Category<input name="category" required placeholder="Rent, utilities, supplies..." /></label><label>Description<input name="description" required /></label><label>Amount<input type="number" name="amount" min=".01" step=".01" required /></label><label>Payment method<select name="payment_method"><option value="cash">Cash</option><option value="bank">Bank</option><option value="card">Card</option></select></label></div><FormActions cancel={() => setForm(null)} submit="Record expense" /></form>}
    {form === "shift" && <form className="form-panel" onSubmit={openShift}><h2>Open cash register</h2><p className="subtle">Enter the opening float for this cashier's shift.</p><div className="form-grid"><label>Opening cash<input type="number" name="opening_cash" min="0" step=".01" required /></label><label>Notes<input name="notes" /></label></div><FormActions cancel={() => setForm(null)} submit="Open shift" /></form>}
    <section className="panel cash-panel"><div className="panel-header"><div><h2>Register shifts</h2><p>Expected and counted closing balance by cashier</p></div><button className="text-button" onClick={reloadShifts}>Refresh<ChevronRight size={15} /></button></div>{shifts?.length ? shifts.map((shift) => <div className="shift-row" key={String(shift.id)}><span className={`shift-state ${shift.closed_at ? "closed" : "open"}`} /><div><strong>{shift.closed_at ? "Closed shift" : "Register open"}</strong><small>{new Date(String(shift.opened_at)).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</small></div><span>Opening {currency(Number(shift.opening_cash))}</span>{shift.closed_at ? <span>Variance {currency(Number(shift.variance))}</span> : <button className="button secondary small" onClick={() => closeShift(shift)}>Close register</button>}</div>) : <EmptyState title="No register shifts" body="Open a register when a cashier begins a shift." />}</section>
    {permitted && <section className="panel cash-panel"><div className="panel-header"><div><h2>Recent expenses</h2><p>Petty cash and operating expenses</p></div><button className="text-button" onClick={reloadExpenses}>Refresh<ChevronRight size={15} /></button></div>{expenses?.length ? <DataTable rows={expenses} fields={["category", "description", "amount", "payment_method", "created_at"]} /> : <EmptyState title="No expenses recorded" body="Expenses will appear here after the first entry." />}</section>}
    {permitted && <><div className="metric-grid small-metrics">{Object.entries(data?.account_balances ?? {}).slice(0, 4).map(([account, balance]) => <div className="metric-card" key={account}><span className="metric-top">{account.replaceAll("_", " ")}</span><div className="metric-value compact">{currency(balance)}</div></div>)}</div>
    <section className="panel table-panel">{error ? <ErrorPanel message={error} onRetry={reload} /> : loading ? <TableSkeleton /> : <DataTable rows={data?.entries ?? []} fields={["date", "account", "type", "reference", "description", "debit", "credit", "balance"]} empty="No ledger entries yet." />}</section></>}
  </div>;
}

function ReportsPage() {
  const reports = [
    { title: "Sales summary", description: "Sales, gross profit, and cashier activity by date range.", endpoint: "/api/reports/sales", dated: true },
    { title: "Inventory valuation", description: "On-hand quantities, purchase-cost valuation, and expiry.", endpoint: "/api/reports/inventory", dated: false },
  ];
  const [report, setReport] = useState(reports[0]);
  const [period, setPeriod] = useState<ExpensePeriod>("monthly");
  const [range, setRange] = useState<DateRange>(() => defaultDateRange("monthly"));
  const path = report.dated
    ? `${report.endpoint}?${new URLSearchParams({ start_date: range.start, end_date: range.end, timezone_name: browserTimezone() })}`
    : report.endpoint;
  const { data, error, loading, reload } = useLoad<Row[] | {
    rows?: Row[]; daily?: Row[]; products?: Row[];
    transactions?: number; revenue?: number; profit?: number;
  }>(path);
  const rows = Array.isArray(data) ? data : data?.rows ?? data?.daily ?? data?.products ?? [];
  function choosePeriod(next: ExpensePeriod) {
    setPeriod(next);
    if (next !== "custom") setRange(defaultDateRange(next));
  }
  return <div className="page-stack"><PageTitle title="Reports" subtitle="Operational insights and exportable pharmacy reports." action={<button className="button secondary" onClick={() => exportCsv(rows, "report.csv")}><FileBarChart size={16} />Export CSV</button>} />
    <div className="report-cards">{reports.map((item, index) => <button className={`report-card ${item.endpoint === report.endpoint ? "selected" : ""}`} key={item.title} onClick={() => setReport(item)}><span className={`report-icon report-${index}`}><FileBarChart size={18} /></span><strong>{item.title}</strong><small>{item.description}</small><ChevronRight size={16} /></button>)}</div>
    {report.dated && <>
      <section className="panel expense-filters"><div className="period-switch" role="group" aria-label="Sales report date range">{(["today", "weekly", "monthly", "yearly", "custom"] as const).map((option) => <button key={option} className={period === option ? "active" : ""} aria-pressed={period === option} onClick={() => choosePeriod(option)}>{option === "today" ? "Today" : option === "custom" ? "Custom range" : `This ${option.slice(0, -2)}`}</button>)}</div>
        {period === "custom" && <div className="date-range-fields"><label>From<input type="date" required value={range.start} max={range.end} onChange={(event) => setRange((current) => ({ ...current, start: event.target.value }))} /></label><label>To<input type="date" required value={range.end} min={range.start} onChange={(event) => setRange((current) => ({ ...current, end: event.target.value }))} /></label></div>}
        <span className="subtle">Showing {range.start} to {range.end}</span></section>
      {!error && !loading && !Array.isArray(data) && <div className="metric-grid small-metrics">
        <div className="metric-card"><span className="metric-top">Sales transactions</span><div className="metric-value compact">{data?.transactions ?? 0}</div></div>
        <div className="metric-card"><span className="metric-top">Sales revenue</span><div className="metric-value compact">{currency(data?.revenue)}</div></div>
        <div className="metric-card"><span className="metric-top">Gross profit</span><div className="metric-value compact">{currency(data?.profit)}</div></div>
      </div>}
    </>}
    <section className="panel table-panel"><div className="panel-header report-heading"><div><h2>{report.title}</h2><p>{report.dated ? `Sales grouped by day from ${range.start} to ${range.end}` : "Report data from your active store"}</p></div><button className="icon-button" onClick={reload} aria-label="Refresh report"><Activity size={17} /></button></div>{error ? <ErrorPanel message={error} onRetry={reload} /> : loading ? <TableSkeleton /> : <DataTable rows={rows} fields={rows[0] ? Object.keys(rows[0]) : []} empty="No report data available for this period." />}</section>
  </div>;
}

function UsersPage({ role, notify }: { role: string; notify: (message: string) => void }) {
  const { data, error, loading, reload } = useLoad<Row[]>("/api/users");
  const [open, setOpen] = useState(false);
  if (role !== "owner") return <div className="page-stack"><PageTitle title="Users & access" subtitle="Manage role-based access to your store." /><EmptyState title="Owner access required" body="Only the pharmacy owner can view or manage user accounts." /></div>;
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget));
    try { await post("/api/users", body); notify("User created"); setOpen(false); reload(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : "Unable to create user."); }
  }
  return <div className="page-stack"><PageTitle title="Users & access" subtitle="Create team accounts with store-specific roles." action={<button className="button primary" onClick={() => setOpen(!open)}><Plus size={16} />Add user</button>} />
    {open && <form className="form-panel" onSubmit={create}><h2>New team member</h2><p className="subtle">Staff use separate accounts. Owner-level access cannot be assigned to staff.</p><div className="form-grid"><label>Full name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label><label>Temporary password<input name="password" type="password" minLength={12} required /><small>At least 12 characters</small></label><label>Role<select name="role"><option value="cashier">Cashier</option><option value="pharmacist">Pharmacist</option><option value="manager">Manager</option><option value="accountant">Accountant</option></select></label></div><FormActions cancel={() => setOpen(false)} submit="Create account" /></form>}
    <section className="panel table-panel">{error ? <ErrorPanel message={error} onRetry={reload} /> : loading ? <TableSkeleton /> : <DataTable rows={data ?? []} fields={["name", "email", "role"]} empty="No team members found." />}</section>
  </div>;
}

function SubscriptionPage({ role, notify, refreshStatus }: {
  role: string;
  notify: (message: string) => void;
  refreshStatus: () => void;
}) {
  const { data: account, error: accountError, loading: accountLoading, reload: reloadAccount } = useLoad<BillingStatus>("/api/billing/status");
  const { data: invoices, error: invoicesError, loading: invoicesLoading, reload: reloadInvoices } = useLoad<SubscriptionInvoice[]>("/api/billing/invoices");
  const { data: methods, error: methodsError, loading: methodsLoading, reload: reloadMethods } = useLoad<PaymentInstruction[]>("/api/billing/payment-instructions");
  const [error, setError] = useState("");

  async function submitPayment(event: FormEvent<HTMLFormElement>, invoice: SubscriptionInvoice) {
    event.preventDefault();
    setError("");
    const body = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await post(`/api/billing/invoices/${invoice.id}/payment`, {
        method: body.method,
        paid_amount: Number(body.paid_amount),
        reference: body.reference,
      });
      notify("Payment reference submitted for verification.");
      reloadInvoices();
      reloadAccount();
      refreshStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to submit payment details.");
    }
  }

  const date = (value: string | null) => value
    ? new Date(value).toLocaleDateString("en", { dateStyle: "medium" })
    : "Not set";

  return <div className="page-stack">
    <PageTitle title="Subscription & billing" subtitle="Review your plan invoices and submit local payment references." />
    {error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}
    {accountError ? <ErrorPanel message={accountError} onRetry={reloadAccount} /> : accountLoading ? <TableSkeleton /> : account && <section className="panel settings-note">
      <CreditCard size={18} /><div><strong>{account.pharmacy_name} · {account.plan_code}</strong><p>Account status: {account.status}. Access {account.restricted ? "is restricted until payment is verified." : "is currently available."} Subscription expires {date(account.subscription_expires_at)}.</p></div>
    </section>}
    <section className="panel table-panel">
      <div className="panel-header"><div><h2>Payment instructions</h2><p>Wallet and bank transfers are manually verified before activation.</p></div><Banknote size={18} className="subtle-icon" /></div>
      {methodsError ? <ErrorPanel message={methodsError} onRetry={reloadMethods} /> : methodsLoading ? <ListSkeleton /> : methods?.length ? <div className="form-grid">{methods.map((method) => <div className="settings-note" key={method.method}><div><strong>{method.label}</strong>
        {method.account_name && <p>Account name: {method.account_name}</p>}
        {method.account_number && <p>Account number: {method.account_number}</p>}
        {method.bank_name && <p>Bank: {method.bank_name}</p>}
        {method.account_title && <p>Account title: {method.account_title}</p>}
        {method.iban && <p>IBAN: {method.iban}</p>}
        {method.instructions && <p>{method.instructions}</p>}
      </div></div>)}</div> : <EmptyState title="No payment instructions configured" body="Contact MedFlow support for local payment details." />}
      <p className="subtle">Never share wallet PINs, passwords, or one-time codes. Payment is not activated until the MedFlow operator verifies the transfer.</p>
    </section>
    <section className="panel table-panel">
      <div className="panel-header"><div><h2>Subscription invoices</h2><p>Invoices are issued by your MedFlow account manager.</p></div><button className="button secondary small" onClick={() => { reloadInvoices(); reloadAccount(); refreshStatus(); }}><Activity size={15} />Refresh</button></div>
      {invoicesError ? <ErrorPanel message={invoicesError} onRetry={reloadInvoices} /> : invoicesLoading ? <TableSkeleton /> : invoices?.length ? <div className="invoice-list">{invoices.map((invoice) => <article className="invoice-card" key={invoice.id}>
        <div className="panel-header"><div><h3>{invoice.invoice_number}</h3><p>{invoice.plan_code} · {date(invoice.period_start)} – {date(invoice.period_end)}</p></div><span className={`status-badge ${invoice.status === "paid" ? "success" : invoice.status === "rejected" ? "danger" : "neutral"}`}>{invoice.status}</span></div>
        <div className="invoice-total"><span>Amount due · due {date(invoice.due_at)}</span><strong>{new Intl.NumberFormat("en", { style: "currency", currency: invoice.currency }).format(Number(invoice.amount))}</strong></div>
        {invoice.payment_reference && <p className="subtle">Submitted: {invoice.payment_method?.replaceAll("_", " ")} · reference {invoice.payment_reference}. {invoice.review_note}</p>}
        {role === "owner" && ["due", "rejected"].includes(invoice.status) && <form className="form-grid" onSubmit={(event) => void submitPayment(event, invoice)}>
          <label>Payment method<select name="method" required>{methods?.map((method) => <option key={method.method} value={method.method}>{method.label}</option>)}</select></label>
          <label>Amount paid<input name="paid_amount" type="number" min="0.01" step="0.01" defaultValue={invoice.amount} required /></label>
          <label>Wallet or bank transaction reference<input name="reference" minLength={4} maxLength={120} required /></label>
          <button className="button primary">Submit payment reference</button>
        </form>}
      </article>)}</div> : <EmptyState title="No subscription invoices" body="Your account manager will issue a plan invoice when billing is arranged." />}
    </section>
  </div>;
}

function SettingsPage({ role, notify }: { role: string; notify: (message: string) => void }) {
  const { data, error, loading, reload } = useLoad<Row>("/api/store");
  const [passwordError, setPasswordError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (role !== "owner") { notify("Only the pharmacy owner can update store settings."); return; }
    const form = Object.fromEntries(new FormData(event.currentTarget));
    try { await patch("/api/store", { ...form, tax_rate: Number(form.tax_rate), expiry_alert_days: Number(form.expiry_alert_days) }); notify("Store settings saved"); reload(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : "Unable to save settings."); }
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPasswordError("");
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    if (body.new_password !== body.confirm_password) { setPasswordError("The new passwords do not match."); return; }
    try {
      await post("/api/auth/password", {
        current_password: body.current_password,
        new_password: body.new_password,
      });
      saveToken(null);
      notify("Password updated; all sessions were signed out.");
      window.location.reload();
    } catch (cause) {
      setPasswordError(cause instanceof Error ? cause.message : "Unable to change password.");
    }
  }
  return <div className="page-stack"><PageTitle title="Store settings" subtitle="Store profile, invoice defaults, and expiry alert configuration." />
    {error ? <ErrorPanel message={error} onRetry={reload} /> : loading ? <TableSkeleton /> : <form className="form-panel settings-form" onSubmit={save}><div className="panel-header"><div><h2>Store profile</h2><p>These details are used throughout your workspace.</p></div><span className="tag tag-neutral"><Settings size={14} />Configuration</span></div><div className="form-grid">{["name", "address", "phone", "tax_number", "currency", "tax_rate", "expiry_alert_days", "invoice_prefix"].map((field) => <label key={field}>{field.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}<input name={field} defaultValue={String(data?.[field] ?? "")} required={["name", "currency", "invoice_prefix"].includes(field)} disabled={role !== "owner"} type={["tax_rate", "expiry_alert_days"].includes(field) ? "number" : "text"} /></label>)}</div>{role === "owner" && <div className="form-actions"><button className="button primary">Save changes</button></div>}</form>}
    <section className="panel settings-note"><ShieldCheck size={18} /><div><strong>Security & audit</strong><p>Administrative changes are recorded in the activity log.</p></div><button className="text-button" onClick={() => api<Row[]>("/api/audit").then((rows) => notify(`${rows.length} audit events loaded`)).catch((e: Error) => notify(e.message))}>View activity log<ChevronRight size={15} /></button></section>
    <form className="form-panel" onSubmit={changePassword}><h2>Change your password</h2><p className="subtle">At least 12 characters. Existing signed-in sessions will be revoked.</p><div className="form-grid"><label>Current password<input name="current_password" type="password" autoComplete="current-password" required /></label><label>New password<input name="new_password" type="password" autoComplete="new-password" minLength={12} required /></label><label>Confirm new password<input name="confirm_password" type="password" autoComplete="new-password" minLength={12} required /></label></div>{passwordError && <div className="form-error"><AlertTriangle size={15} />{passwordError}</div>}<div className="form-actions"><button className="button primary">Update password</button></div></form>
  </div>;
}

function PageTitle({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">PHARMACY OPERATIONS</p><h1>{title}</h1><p className="subtle">{subtitle}</p></div>{action && <div className="heading-actions">{action}</div>}</div>;
}

function DataTable({ rows, fields, labels = {}, empty, actions }: { rows: Row[]; fields: string[]; labels?: Record<string,string>; empty?: string; actions?: (row: Row) => ReactNode }) {
  if (!rows.length) return <EmptyState title="Nothing to show yet" body={empty ?? "Records will appear here when added."} />;
  const pretty = (value: unknown, field: string) => {
    if (value == null || value === "") return "—";
    if ((typeof value === "number" || typeof value === "string") && ["subtotal", "tax_total", "total", "sale_price", "purchase_price", "opening_balance", "credit_limit", "debit", "credit", "balance", "amount", "inventory_value", "unit_cost"].includes(field) && Number.isFinite(Number(value))) return currency(Number(value));
    if (typeof value === "string" && value.includes("T") && !Number.isNaN(Date.parse(value)) && (field.includes("date") || field.endsWith("_at"))) return new Date(value).toLocaleString("en", { dateStyle: "medium" });
    if (typeof value === "string" && ["status", "role"].includes(field)) {
      const normalized = value.toLowerCase();
      const tone = ["received", "completed", "active", "paid"].includes(normalized) ? "success"
        : ["suspended", "cancelled", "rejected", "void"].includes(normalized) ? "danger"
        : ["trial", "submitted", "due"].includes(normalized) ? "warning" : "neutral";
      return <span className={`status-badge ${tone}`}>{value.replace(/_/g, " ")}</span>;
    }
    return String(value);
  };
  return <div className="table-scroll"><table><thead><tr>{fields.map((field) => <th key={field}>{labels[field] ?? field.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}<ChevronDown size={12} /></th>)}{actions && <th>Actions</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? row.reference ?? index)}>{fields.map((field) => <td key={field}>{pretty(row[field], field)}</td>)}{actions && <td>{actions(row)}</td>}</tr>)}</tbody></table></div>;
}

function FormActions({ cancel, submit }: { cancel: () => void; submit: string }) {
  return <div className="form-actions"><button type="button" className="button secondary" onClick={cancel}>Cancel</button><button className="button primary"><Check size={16} />{submit}</button></div>;
}
function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="empty-state"><span className="empty-icon"><Boxes size={20} /></span><strong>{title}</strong><p>{body}</p></div>;
}
function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="error-panel"><span className="alert-icon red"><AlertTriangle size={17} /></span><div><strong>We couldn't load this data</strong><p>{message}</p><button className="text-button" onClick={onRetry}>Try again <ChevronRight size={15} /></button></div></div>;
}
function TableSkeleton() { return <div className="skeleton-list">{[0,1,2,3].map((row) => <div className="skeleton-row" key={row}>{[0,1,2,3].map((cell) => <span className="skeleton" key={cell} />)}</div>)}</div>; }
function ListSkeleton() { return <div className="list-skeleton">{[0,1,2,3].map((i) => <div className="skeleton" key={i} />)}</div>; }
function ChartSkeleton() { return <div className="chart-skeleton">{[40,65,48,80,56,92,64,72,50,85,60,97,55,70].map((height, i) => <i key={i} style={{ height: `${height}%` }} />)}</div>; }
function exportCsv(rows: Row[], filename: string) {
  if (!rows.length) return;
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [keys.map(quote).join(","), ...rows.map((row) => keys.map((key) => quote(row[key])).join(","))].join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = filename; link.click(); URL.revokeObjectURL(link.href);
}

export default App;
