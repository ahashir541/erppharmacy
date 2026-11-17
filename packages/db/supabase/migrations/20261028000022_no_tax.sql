-- 0022: MedFlow has no sales tax and no link to FBR or any tax authority (the owner's decision,
-- D55). Bills never carry tax; the tax tables, permissions and the integration feature are gone.
-- (Bill rows keep their tax columns, always 0, so the shared bill maths stays one code path.)

-- No item is ever taxed.
create or replace function app.tax_rate_bp(p_product uuid, p_date date) returns int
language sql immutable as $$ select 0 $$;

drop table if exists tax_submissions cascade;
drop table if exists tax_profiles cascade;

-- Tax permissions and the "FBR / provincial integration" feature.
alter table role_permissions disable trigger user;
alter table user_permission_overrides disable trigger user;
alter table role_template_permissions disable trigger user;
alter table permissions disable trigger user;
delete from role_permissions where permission_code in ('tax.view', 'tax.manage', 'reports.tax');
delete from user_permission_overrides where permission_code in ('tax.view', 'tax.manage', 'reports.tax');
delete from role_template_permissions where permission_code in ('tax.view', 'tax.manage', 'reports.tax');
update approval_requests set permission_code = null where permission_code in ('tax.view', 'tax.manage', 'reports.tax');
delete from permissions where code in ('tax.view', 'tax.manage', 'reports.tax');
alter table role_permissions enable trigger user;
alter table user_permission_overrides enable trigger user;
alter table role_template_permissions enable trigger user;
alter table permissions enable trigger user;

alter table plan_features disable trigger user;
alter table tenant_feature_overrides disable trigger user;
alter table feature_rollouts disable trigger user;
alter table features disable trigger user;
delete from plan_features where feature_code = 'tax_integration';
delete from tenant_feature_overrides where feature_code = 'tax_integration';
delete from feature_rollouts where feature_code = 'tax_integration';
delete from features where code = 'tax_integration';
alter table plan_features enable trigger user;
alter table tenant_feature_overrides enable trigger user;
alter table feature_rollouts enable trigger user;
alter table features enable trigger user;

-- Nothing can be "stuck at the tax authority".
delete from alert_rules where kind = 'tax_queue_stuck';

select app.assert_rls_everywhere();
