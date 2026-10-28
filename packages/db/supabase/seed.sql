-- Development seed (local Supabase only; `supabase db reset` runs it).
-- Plans follow the brief's examples. Prices are 0 here on purpose: real
-- prices are set by the platform owner in the console, never in code.
-- The "Demo Pharmacy" (2 branches, 500 products, 30 days of sales) is added
-- in Phase 2-3, once products and sales can be created.

insert into plans (code, name, trial_days, sort_order) values
  ('basic', 'Basic', 14, 1),
  ('pro', 'Pro', 14, 2),
  ('enterprise', 'Enterprise', 14, 3)
on conflict (code) do nothing;

insert into plan_features (plan_id, feature_code, enabled, limit_value)
select p.id, f.feature_code, f.enabled, f.limit_value
from plans p
join (values
  ('basic', 'max_branches', true, 1), ('basic', 'max_counters', true, 2), ('basic', 'max_staff', true, 5),
  ('basic', 'pos', true, null), ('basic', 'stock', true, null), ('basic', 'udhaar', true, null),
  ('basic', 'basic_reports', true, null),

  ('pro', 'max_branches', true, 3), ('pro', 'max_counters', true, 10), ('pro', 'max_staff', true, 25),
  ('pro', 'pos', true, null), ('pro', 'stock', true, null), ('pro', 'udhaar', true, null),
  ('pro', 'basic_reports', true, null), ('pro', 'tax_integration', true, null),
  ('pro', 'owner_app', true, null), ('pro', 'approvals', true, null), ('pro', 'whatsapp', true, null),

  ('enterprise', 'max_branches', true, null), ('enterprise', 'max_counters', true, null),
  ('enterprise', 'max_staff', true, null),
  ('enterprise', 'pos', true, null), ('enterprise', 'stock', true, null), ('enterprise', 'udhaar', true, null),
  ('enterprise', 'basic_reports', true, null), ('enterprise', 'tax_integration', true, null),
  ('enterprise', 'owner_app', true, null), ('enterprise', 'approvals', true, null),
  ('enterprise', 'whatsapp', true, null), ('enterprise', 'warehouse', true, null),
  ('enterprise', 'transfers', true, null), ('enterprise', 'api_access', true, null),
  ('enterprise', 'ai_features', true, null), ('enterprise', 'white_label', true, null),
  ('enterprise', 'branch_hub', true, null)
) as f(plan_code, feature_code, enabled, limit_value) on f.plan_code = p.code
on conflict (plan_id, feature_code) do nothing;
