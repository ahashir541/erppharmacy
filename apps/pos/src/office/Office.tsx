// The owner's back office: a collapsible sidebar, a top bar (branch, search / command palette,
// sync status) and the pages. The POS is one click (or Ctrl+K → "POS") away.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppProps, Session } from '../App.tsx';
import { Approvals, Settings, Team } from './admin.tsx';
import { Accounts, Expenses, Reports } from './money.tsx';
import { Customers, Suppliers } from './parties.tsx';
import { Purchases } from './purchases.tsx';
import { Dashboard, Invoices, Shifts } from './sales.tsx';
import { StockCounts } from './counts.tsx';
import { Expiry, Movements, Products } from './stock.tsx';
import type { PageProps } from './ui.tsx';

const LABEL_UR: Record<string, string> = {"dashboard": "ڈیش بورڈ", "pos": "نئی فروخت", "invoices": "فروخت اور بل", "customers": "گاہک اور ادھار", "shifts": "شفٹیں", "products": "ادویات اور اسٹاک", "expiry": "میعاد", "counts": "اسٹاک گنتی", "movements": "اسٹاک کی آمد و رفت", "suppliers": "سپلائرز", "purchases": "خریداری", "expenses": "اخراجات", "accounts": "حسابات", "reports": "رپورٹس", "approvals": "منظوریاں اور الرٹس", "team": "عملہ", "settings": "ترتیبات"};
const GROUP_LABEL_UR: Record<string, string> = {"Overview": "جائزہ", "Sales": "فروخت", "Inventory": "اسٹاک", "Purchasing": "خریداری", "Money": "رقم", "Admin": "انتظام"};

interface NavItem { key: string; label: string; icon: string; group: string; render?: (p: PageProps) => ReactNode; soon?: boolean }

const NAV: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: '▦', group: 'Overview', render: (p) => <Dashboard {...p} /> },
  { key: 'pos', label: 'POS / New sale', icon: '⌁', group: 'Overview' },
  { key: 'invoices', label: 'Sales & invoices', icon: '≡', group: 'Sales', render: (p) => <Invoices {...p} /> },
  { key: 'customers', label: 'Customers & udhaar', icon: '☺', group: 'Sales', render: (p) => <Customers {...p} /> },
  { key: 'shifts', label: 'Shifts', icon: '◷', group: 'Sales', render: (p) => <Shifts {...p} /> },
  { key: 'products', label: 'Products & stock', icon: '▤', group: 'Inventory', render: (p) => <Products {...p} /> },
  { key: 'expiry', label: 'Expiry', icon: '⚠', group: 'Inventory', render: (p) => <Expiry {...p} /> },
  { key: 'counts', label: 'Stock count', icon: '☑', group: 'Inventory', render: (p) => <StockCounts {...p} /> },
  { key: 'movements', label: 'Stock movements', icon: '⇅', group: 'Inventory', render: (p) => <Movements {...p} /> },
  { key: 'suppliers', label: 'Suppliers', icon: '⛟', group: 'Purchasing', render: (p) => <Suppliers {...p} /> },
  { key: 'purchases', label: 'Purchases', icon: '⊕', group: 'Purchasing', render: (p) => <Purchases {...p} /> },
  { key: 'expenses', label: 'Expenses', icon: '−', group: 'Money', render: (p) => <Expenses {...p} /> },
  { key: 'accounts', label: 'Accounts & books', icon: '₨', group: 'Money', render: (p) => <Accounts {...p} /> },
  { key: 'reports', label: 'Reports', icon: '◔', group: 'Money', render: (p) => <Reports {...p} /> },
  { key: 'approvals', label: 'Approvals & alerts', icon: '✓', group: 'Admin', render: (p) => <Approvals {...p} /> },
  { key: 'team', label: 'Team', icon: '☷', group: 'Admin', render: (p) => <Team {...p} /> },
  { key: 'settings', label: 'Settings', icon: '⚙', group: 'Admin', render: (p) => <Settings {...p} /> },
];

export function Office(props: AppProps & { session: Session; onOpenPos: () => void; onSignOut: () => void; onToggleLang: () => void }) {
  const [page, setPage] = useState('dashboard');
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1200);
  const [palette, setPalette] = useState(false);
  const pageProps: PageProps = useMemo(() => ({ db: props.backend, branchId: props.ctx.branch.id, today: props.ctx.today, go: (k) => setPage(k) }),
    [props.backend, props.ctx]);

  const go = (key: string) => {
    if (key === 'pos') { props.onOpenPos(); return; }
    setPage(key);
    setPalette(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ur = props.lang === 'ur';
  const L = (n: NavItem) => (ur ? LABEL_UR[n.key] ?? n.label : n.label);
  const G = (g: string) => (ur ? GROUP_LABEL_UR[g] ?? g : g);
  const current = NAV.find((n) => n.key === page)!;
  const groups = [...new Set(NAV.map((n) => n.group))];
  return (
    <div className={`office${collapsed ? ' collapsed' : ''}`}>
      <aside className="sidebar" aria-label="Main menu">
        <div className="sidebar-head">
          <button type="button" className="brand-home" title="Dashboard" onClick={() => go('dashboard')}>
            <span className="brand-mark">N</span>
            {!collapsed && <span className="brand-name">Nuskha</span>}
          </button>
          <button type="button" className="icon-btn collapse-btn" aria-label={collapsed ? 'Expand menu' : 'Collapse menu'} onClick={() => setCollapsed((c) => !c)}>{collapsed ? '»' : '«'}</button>
        </div>
        <nav>
          {groups.map((g) => (
            <div key={g} className="nav-group">
              {!collapsed && <div className="nav-group-label">{G(g)}</div>}
              {NAV.filter((n) => n.group === g).map((n) => (
                <button key={n.key} type="button" title={L(n)} className={`nav-item${page === n.key ? ' on' : ''}${n.soon ? ' soon' : ''}`} onClick={() => go(n.key)}>
                  <span className="nav-icon" aria-hidden>{n.icon}</span>
                  {!collapsed && <span className="nav-label">{L(n)}</span>}
                  {!collapsed && n.soon && <span className="nav-soon">next</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          {!collapsed && <div className="who-block"><strong>{props.session.staff.name}</strong><span className="muted small">Owner</span></div>}
          <button type="button" className="link-btn" onClick={props.onSignOut}>{collapsed ? '⏻' : 'Sign out'}</button>
        </div>
      </aside>
      <div className="office-main">
        <header className="office-top">
          <div className="branch-switch" title="Branch">{props.ctx.pharmacy} · <strong>{props.ctx.branch.name}</strong></div>
          <button type="button" className="global-search" onClick={() => setPalette(true)}>
            <span aria-hidden>⌕</span> Search or jump to… <kbd>Ctrl K</kbd>
          </button>
          <button type="button" className="link-btn" onClick={props.onToggleLang}>{props.lang === 'ur' ? 'English' : 'اردو'}</button>
          <button type="button" className="btn primary" onClick={props.onOpenPos}>New sale</button>
        </header>
        <main className="office-content">
          {current.render ? current.render(pageProps) : <ComingNext label={current.label} />}
        </main>
      </div>
      {palette && <CommandPalette onPick={go} onClose={() => setPalette(false)} />}
      <div id="print-area" aria-hidden />
    </div>
  );
}

function ComingNext(props: { label: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden>◌</div>
      <h2>{props.label}</h2>
      <p className="muted">This screen is next. Its rules already work in Nuskha's database (tested); the screen is being built on the new design system.</p>
    </div>
  );
}

/** Ctrl+K: type to jump to any page. */
function CommandPalette(props: { onPick: (key: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const hits = NAV.filter((n) => n.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input autoFocus placeholder="Jump to… (e.g. expiry, customers, new sale)" value={q}
               onChange={(e) => { setQ(e.target.value); setI(0); }}
               onKeyDown={(e) => {
                 if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(hits.length - 1, x + 1)); }
                 if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
                 if (e.key === 'Enter' && hits[i]) props.onPick(hits[i]!.key);
                 if (e.key === 'Escape') props.onClose();
               }} />
        <ul>
          {hits.map((n, j) => (
            <li key={n.key} className={j === i ? 'on' : ''} onMouseEnter={() => setI(j)} onMouseDown={() => props.onPick(n.key)}>
              <span className="nav-icon" aria-hidden>{n.icon}</span>{n.label}<span className="muted small palette-group">{n.group}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
