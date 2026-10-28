-- 0013: reference data — permission catalogue, default role matrix, and the
-- feature catalogue. Plan prices are NOT seeded; they are set in the console.
--
-- counter_safe = a counter device principal may read data guarded by it.
-- is_sensitive = money visibility; off for everyone but the owner by default.

insert into permissions (code, module, name, limit_kind, is_sensitive, counter_safe, sort_order) values
  -- sales
  ('sales.create',            'sales', 'Make sales and print bills',              null,             false, true,  10),
  ('sales.hold',              'sales', 'Hold and resume bills',                   null,             false, false, 11),
  ('sales.reprint',           'sales', 'Reprint a bill',                          null,             false, false, 12),
  ('sales.lookup_recent',     'sales', 'Find recent bills of this branch',        null,             false, true,  13),
  ('sales.view_all',          'sales', 'See all bills of the branch',             null,             false, false, 14),
  ('sales.view_totals',       'sales', 'See sales totals',                        null,             true,  false, 15),
  ('sales.view_profit',       'sales', 'See profit and margin',                   null,             true,  false, 16),
  ('sales.discount',          'sales', 'Give discount',                           'percent_bp',     false, false, 17),
  ('sales.edit_price',        'sales', 'Edit sale price',                         null,             false, false, 18),
  ('sales.sell_below_min',    'sales', 'Sell below minimum price',                null,             false, false, 19),
  ('sales.negative_stock',    'sales', 'Sell when stock shows zero',              null,             false, false, 20),
  ('sales.void',              'sales', 'Void a bill',                             'count_per_day',  false, false, 21),
  ('sales.return',            'sales', 'Accept a return',                         'amount',         false, false, 22),
  -- products & stock
  ('product.manage',          'products', 'Add and edit products',                null,             false, false, 30),
  ('product.view_cost',       'products', 'See cost price and margin',            null,             true,  false, 31),
  ('product.price_change',    'products', 'Change selling prices',                null,             false, false, 32),
  ('product.bulk_price',      'products', 'Bulk price update',                    null,             false, false, 33),
  ('product.import',          'products', 'Import products from file',            null,             false, false, 34),
  ('stock.view',              'stock', 'See stock quantities',                    null,             false, true,  40),
  ('stock.adjust',            'stock', 'Adjust stock',                            'count_per_day',  false, false, 41),
  ('stock.count',             'stock', 'Run stock counts',                        null,             false, false, 42),
  ('stock.view_variance',     'stock', 'See stock count variance',                null,             true,  false, 43),
  ('stock.transfer',          'stock', 'Send and receive transfers',              null,             false, false, 44),
  ('stock.expiry_actions',    'stock', 'Return to supplier / mark for disposal',  null,             false, false, 45),
  ('stock.block_batch',       'stock', 'Block or unblock a batch',                null,             false, false, 46),
  -- purchasing
  ('suppliers.view',          'purchasing', 'See suppliers',                      null,             false, false, 50),
  ('suppliers.manage',        'purchasing', 'Add and edit suppliers',             null,             false, false, 51),
  ('purchases.orders',        'purchasing', 'Create and send purchase orders',    null,             false, false, 52),
  ('purchases.receive',       'purchasing', 'Receive goods (GRN)',                null,             false, false, 53),
  ('purchases.view_cost',     'purchasing', 'See purchase costs',                 null,             true,  false, 54),
  ('purchases.invoices',      'purchasing', 'Enter purchase invoices',            null,             true,  false, 55),
  ('purchases.returns',       'purchasing', 'Purchase returns',                   null,             false, false, 56),
  -- customers & prescriptions
  ('customers.view',          'customers', 'See customers',                       null,             false, true,  60),
  ('customers.manage',        'customers', 'Add and edit customers',              null,             false, false, 61),
  ('prescriptions.view',      'customers', 'See prescriptions',                   null,             false, false, 62),
  ('prescriptions.confirm',   'customers', 'Pharmacist confirmation',             null,             false, false, 63),
  ('controlled.dispense',     'customers', 'Dispense controlled drugs',           'count_per_day',  false, false, 64),
  -- udhaar
  ('udhaar.check_status',     'udhaar', 'See if a customer may take udhaar',      null,             false, true,  70),
  ('udhaar.give',             'udhaar', 'Give udhaar',                            'amount',         false, false, 71),
  ('udhaar.limit_override',   'udhaar', 'Give udhaar over the limit',             'amount',         false, false, 72),
  ('udhaar.view_balance',     'udhaar', 'See customer balances',                  null,             true,  false, 73),
  ('udhaar.receive_payment',  'udhaar', 'Receive udhaar payments',                null,             false, false, 74),
  ('udhaar.set_limits',       'udhaar', 'Set credit limits',                      null,             false, false, 75),
  ('udhaar.block',            'udhaar', 'Block a customer from udhaar',           null,             false, false, 76),
  ('udhaar.write_off',        'udhaar', 'Write off bad debt',                     null,             true,  false, 77),
  ('udhaar.reminders',        'udhaar', 'Send udhaar reminders',                  null,             false, false, 78),
  ('payables.view',           'udhaar', 'See supplier payables',                  null,             true,  false, 79),
  ('payables.pay',            'udhaar', 'Pay suppliers',                          'amount',         true,  false, 80),
  ('cheques.manage',          'udhaar', 'Record and update cheques',              null,             false, false, 81),
  -- cash & expenses
  ('cash.open_drawer',        'cash', 'Open drawer without a sale',               'count_per_day',  false, false, 90),
  ('cash.close_shift',        'cash', 'Close own shift (blind count)',            null,             false, false, 91),
  ('cash.view',               'cash', 'See cash and bank balances',               null,             true,  false, 92),
  ('cash.view_variance',      'cash', 'See cash short / over',                    null,             true,  false, 93),
  ('cash.payout',             'cash', 'Pay out from drawer',                      'amount',         false, false, 94),
  ('expenses.create',         'cash', 'Record expenses',                          'amount',         false, false, 95),
  ('expenses.view',           'cash', 'See expenses',                             null,             true,  false, 96),
  ('expenses.manage',         'cash', 'Manage expense categories and recurring',  null,             true,  false, 97),
  ('bank.manage',             'cash', 'Manage bank and wallet accounts',          null,             true,  false, 98),
  -- finance & payroll
  ('accounting.view',         'finance', 'See general ledger and trial balance',  null,             true,  false, 100),
  ('accounting.manual_journal','finance', 'Post manual journals',                 null,             true,  false, 101),
  ('payroll.view',            'finance', 'See salaries and advances',             null,             true,  false, 102),
  ('payroll.manage',          'finance', 'Pay salaries and advances',             null,             true,  false, 103),
  -- reports
  ('reports.sales',           'reports', 'Sales reports',                         null,             true,  false, 110),
  ('reports.profit',          'reports', 'Profit reports',                        null,             true,  false, 111),
  ('reports.stock',           'reports', 'Stock reports (quantities)',            null,             false, false, 112),
  ('reports.stock_value',     'reports', 'Stock valuation reports',               null,             true,  false, 113),
  ('reports.expiry',          'reports', 'Expiry reports',                        null,             false, false, 114),
  ('reports.purchases',       'reports', 'Purchase reports',                      null,             true,  false, 115),
  ('reports.udhaar',          'reports', 'Udhaar reports',                        null,             true,  false, 116),
  ('reports.staff',           'reports', 'Staff reports',                         null,             true,  false, 117),
  ('reports.tax',             'reports', 'Tax reports',                           null,             true,  false, 118),
  ('reports.controlled',      'reports', 'Controlled drugs register',             null,             false, false, 119),
  ('data.export',             'reports', 'Export data',                           null,             true,  false, 120),
  -- compliance
  ('tax.view',                'compliance', 'See tax submission queue',           null,             false, false, 130),
  ('tax.manage',              'compliance', 'Tax registration settings',          null,             false, false, 131),
  ('compliance.view',         'compliance', 'See licences',                       null,             false, false, 132),
  ('licences.manage',         'compliance', 'Manage licences',                    null,             false, false, 133),
  -- administration
  ('staff.manage',            'admin', 'Manage staff',                            null,             false, false, 140),
  ('roles.manage',            'admin', 'Manage roles and permissions',            null,             false, false, 141),
  ('settings.manage',         'admin', 'Change settings',                         null,             false, false, 142),
  ('devices.manage',          'admin', 'Register and disable devices',            null,             false, false, 143),
  ('approvals.decide',        'admin', 'Approve requests',                        null,             false, false, 144),
  ('audit.view',              'admin', 'See the audit log',                       null,             true,  false, 145),
  ('flags.view',              'admin', 'See sync flags',                          null,             true,  false, 146),
  ('messages.view',           'admin', 'See outgoing messages',                   null,             false, false, 147),
  ('billing.view',            'admin', 'See MedFlow subscription',                null,             false, false, 148),
  ('support.use',             'admin', 'Contact MedFlow support',                 null,             false, false, 149),
  ('backups.manage',          'admin', 'Backups and data export',                 null,             true,  false, 150);

-- Owner template: everything.
insert into role_template_permissions (template_code, permission_code, allowed)
select 'owner', code, true from permissions;

-- Other templates follow the brief's matrix. allowed = false rows are the
-- "off by default" switches the owner sees. A null limit means no limit.
-- Where the brief says "up to the limit set by the owner", the limit starts
-- at 0 (every use needs approval) until the owner sets one (D16).
insert into role_template_permissions (template_code, permission_code, allowed, needs_approval) values
  ('manager', 'sales.create', true, false), ('manager', 'sales.hold', true, false),
  ('manager', 'sales.reprint', true, false), ('manager', 'sales.lookup_recent', true, false),
  ('manager', 'sales.discount', true, false),
  ('manager', 'sales.void', true, true), ('manager', 'sales.return', true, true),
  ('manager', 'sales.view_totals', false, false), ('manager', 'sales.view_profit', false, false),
  ('manager', 'product.view_cost', false, false), ('manager', 'sales.edit_price', false, false),
  ('manager', 'purchases.receive', true, false), ('manager', 'stock.adjust', true, false),
  ('manager', 'stock.view', true, false), ('manager', 'stock.count', true, false),
  ('manager', 'suppliers.view', true, false),
  ('manager', 'customers.view', true, false), ('manager', 'customers.manage', true, false),
  ('manager', 'udhaar.check_status', true, false), ('manager', 'udhaar.give', true, false),
  ('manager', 'udhaar.receive_payment', true, false),
  ('manager', 'payables.pay', false, false), ('manager', 'expenses.create', false, false),

  ('pharmacist', 'sales.create', true, false), ('pharmacist', 'sales.hold', true, false),
  ('pharmacist', 'sales.reprint', true, false), ('pharmacist', 'sales.lookup_recent', true, false),
  ('pharmacist', 'sales.discount', true, false),
  ('pharmacist', 'sales.void', true, true), ('pharmacist', 'sales.return', true, true),
  ('pharmacist', 'stock.view', true, false), ('pharmacist', 'customers.view', true, false),
  ('pharmacist', 'prescriptions.view', true, false), ('pharmacist', 'prescriptions.confirm', true, false),
  ('pharmacist', 'controlled.dispense', true, false),
  ('pharmacist', 'reports.expiry', true, false), ('pharmacist', 'reports.stock', true, false),

  ('salesman', 'sales.create', true, false), ('salesman', 'sales.hold', true, false),
  ('salesman', 'sales.reprint', true, false), ('salesman', 'sales.lookup_recent', true, false),
  ('salesman', 'sales.discount', true, true),
  ('salesman', 'sales.void', true, true), ('salesman', 'sales.return', true, true),
  ('salesman', 'stock.view', true, false), ('salesman', 'customers.view', true, false),
  ('salesman', 'udhaar.check_status', true, false), ('salesman', 'udhaar.give', true, false),
  ('salesman', 'cash.close_shift', true, false),

  ('storekeeper', 'purchases.receive', true, false), ('storekeeper', 'stock.view', true, false),
  ('storekeeper', 'stock.adjust', true, false), ('storekeeper', 'stock.count', true, false),
  ('storekeeper', 'suppliers.view', true, false), ('storekeeper', 'reports.stock', true, false),

  ('accountant', 'udhaar.view_balance', true, false), ('accountant', 'payables.view', true, false),
  ('accountant', 'customers.view', true, false), ('accountant', 'suppliers.view', true, false),
  ('accountant', 'sales.view_totals', false, false), ('accountant', 'sales.view_profit', false, false),
  ('accountant', 'product.view_cost', false, false),
  ('accountant', 'payables.pay', false, false), ('accountant', 'expenses.create', false, false);

update role_template_permissions set limit_value = 0
where (template_code, permission_code) in (('manager', 'sales.discount'), ('pharmacist', 'sales.discount'),
                                           ('manager', 'udhaar.give'), ('salesman', 'udhaar.give'));

insert into features (code, module, name, kind) values
  ('max_branches',     'limits',     'Branches',                      'limit'),
  ('max_counters',     'limits',     'Counter devices',               'limit'),
  ('max_staff',        'limits',     'Staff accounts',                'limit'),
  ('pos',              'core',       'Point of sale',                 'boolean'),
  ('stock',            'core',       'Stock and expiry',              'boolean'),
  ('udhaar',           'core',       'Udhaar',                        'boolean'),
  ('basic_reports',    'core',       'Basic reports',                 'boolean'),
  ('tax_integration',  'compliance', 'FBR / provincial integration',  'boolean'),
  ('owner_app',        'owner',      'Owner mobile app',              'boolean'),
  ('approvals',        'owner',      'Remote approvals',              'boolean'),
  ('whatsapp',         'messaging',  'WhatsApp / SMS reminders',      'boolean'),
  ('warehouse',        'stock',      'Warehouse',                     'boolean'),
  ('transfers',        'stock',      'Stock transfers',               'boolean'),
  ('api_access',       'platform',   'Public API',                    'boolean'),
  ('ai_features',      'smart',      'AI features (v2)',              'boolean'),
  ('white_label',      'platform',   'White label',                   'boolean'),
  ('branch_hub',       'sync',       'Branch Hub LAN sync (v2)',      'boolean');
