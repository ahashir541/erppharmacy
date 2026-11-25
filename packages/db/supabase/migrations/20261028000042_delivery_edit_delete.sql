-- 0042: Edit or delete a delivery (goods received) entered wrong.
--   * void_grn: the delivery's stock leaves again (as corrections), its supplier invoice is reversed
--     in the supplier's ledger, and the delivery is marked voided (kept for the record, not shown).
--     Refused when some of that stock is already sold or moved: then a return to the supplier is right.
--   * replace_grn: "Edit" = void the old delivery and post the corrected one, in one step.
--   * The voided delivery's cost no longer counts in the batch's average cost.
--   * office_grn_detail: the delivery as the edit form needs it.

create or replace function app.batch_cogs(p_batch uuid, p_qty_base bigint) returns bigint
language sql stable security definer set search_path = public, app as $$
  select case when sum(l.qty_base) > 0 then app.div_round(p_qty_base::numeric * sum(l.total_cost), sum(l.qty_base)) end
  from batch_cost_layers l
  where l.batch_id = p_batch
    and not exists (select 1 from grn_lines gl join grns g on g.id = gl.grn_id where gl.id = l.grn_line_id and g.status = 'voided')
$$;

create or replace function public.void_grn(p_grn uuid, p_reason text, p_session uuid default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  g grns;
  l record;
  have bigint;
  inv purchase_invoices;
  e ledger_entries;
begin
  select * into g from grns where id = p_grn and tenant_id = tid for update;
  if not found then raise exception 'Delivery not found' using errcode = 'P0002'; end if;
  if g.status = 'voided' then return; end if;
  perform app.assert_branch(g.branch_id);
  perform app.require_decision(uid, 'purchases.receive', g.branch_id, null, null, 'other');
  perform app.require_decision(uid, 'purchases.invoices', g.branch_id, null, null, 'other');
  -- Every unit of this delivery must still be on the shelf.
  for l in select gl.batch_id, sum(gl.qty_base + gl.bonus_qty_base) qty, min(p.brand_name) name
           from grn_lines gl join products p on p.id = gl.product_id where gl.grn_id = g.id group by gl.batch_id loop
    select coalesce(qty_base, 0) into have from stock_balances where branch_id = g.branch_id and batch_id = l.batch_id;
    if coalesce(have, 0) < l.qty then
      raise exception '% from this delivery is already sold or moved (% of % left). Use "Return to supplier" or a stock correction instead.',
        l.name, coalesce(have, 0), l.qty using errcode = 'P0001';
    end if;
  end loop;
  for l in select gl.id, gl.product_id, gl.batch_id, gl.qty_base + gl.bonus_qty_base qty from grn_lines gl where gl.grn_id = g.id loop
    if l.qty > 0 then
      insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, reference_type, reference_id,
                                   reference_line_id, reason, occurred_at, created_by, device_id)
      values (tid, g.branch_id, l.product_id, l.batch_id, 'adjust', -l.qty, 'grn_void', g.id, l.id,
              'Delivery ' || g.grn_number || ' deleted: ' || coalesce(nullif(trim(p_reason), ''), 'entered wrong'), now(), uid, app.ctx_device_id());
    end if;
  end loop;
  -- The supplier's bill for it is reversed (any payment stays, as money the supplier now owes back).
  for inv in select * from purchase_invoices where grn_id = g.id and status = 'posted' loop
    for e in select * from ledger_entries where reference_type = 'purchase_invoice' and reference_id = inv.id and entry_type = 'purchase_invoice'
             and not exists (select 1 from ledger_entries r where r.reverses_entry_id = ledger_entries.id) loop
      insert into ledger_entries (tenant_id, branch_id, party_type, supplier_id, entry_type, debit, entry_date, reference_type, reference_id,
                                  reverses_entry_id, memo, occurred_at, created_by, device_id)
      values (tid, e.branch_id, 'supplier', e.supplier_id, 'reversal', e.credit, app.business_date(g.branch_id), 'purchase_invoice', inv.id,
              e.id, 'Delivery ' || g.grn_number || ' deleted', now(), uid, app.ctx_device_id());
    end loop;
    -- Free the supplier's invoice number, so the corrected delivery can use it again.
    update purchase_invoices set status = 'voided', voided_at = now(), void_reason = p_reason,
      supplier_invoice_number = supplier_invoice_number || ' (deleted ' || left(inv.id::text, 8) || ')' where id = inv.id;
  end loop;
  update grns set status = 'voided', voided_at = now(), void_reason = coalesce(nullif(trim(p_reason), ''), 'entered wrong') where id = g.id;
  if g.purchase_order_id is not null then perform app.refresh_po_status(g.purchase_order_id); end if;
  perform app.log_event('grn_voided', 'grns', g.id, jsonb_build_object('grn_number', g.grn_number, 'reason', p_reason), g.branch_id);
end $$;

-- Edit: the corrected delivery replaces the old one (same supplier invoice number is allowed again).
create or replace function public.replace_grn(p_old uuid, p jsonb, p_session uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
begin
  perform public.void_grn(p_old, 'Edited', p_session);
  return public.post_grn(p, p_session);
end $$;

create or replace function public.office_grn_detail(p_grn uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select jsonb_build_object(
    'id', g.id, 'grn_number', g.grn_number, 'supplier_id', g.supplier_id, 'purchase_order_id', g.purchase_order_id,
    'invoice_no', coalesce(pi.supplier_invoice_number, g.supplier_invoice_number), 'invoice_date', pi.invoice_date, 'paid', pi.paid_at_receipt,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', gl.product_id, 'brand_name', p.brand_name, 'unit_id', gl.product_unit_id, 'qty', gl.qty, 'bonus', gl.bonus_qty,
        'batch', nullif(b.batch_number, '-'), 'expiry', b.expiry_date, 'cost', c.unit_cost, 'discount', c.discount_amount, 'retail', b.retail_price,
        'units', (select json_agg(json_build_object('id', pu.id, 'name', u.name, 'factor', pu.factor_to_base) order by pu.factor_to_base desc)
                  from product_units pu join units u on u.id = pu.unit_id where pu.product_id = p.id and pu.archived_at is null))
        order by gl.created_at), '[]')
      from grn_lines gl join products p on p.id = gl.product_id join batches b on b.id = gl.batch_id
      left join grn_line_costs c on c.grn_line_id = gl.id where gl.grn_id = g.id))
  from grns g left join purchase_invoices pi on pi.grn_id = g.id and pi.status = 'posted'
  where g.id = p_grn
$$;

-- Deleted deliveries are not listed.
create or replace function public.office_deliveries(p_branch uuid) returns jsonb
language sql security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.received_at desc)) from (
    select g.id, g.grn_number, g.received_at, s.name supplier, coalesce(pi.supplier_invoice_number, g.supplier_invoice_number) invoice_no, pi.grand_total total,
           (select count(*) from grn_lines gl where gl.grn_id = g.id)::int lines,
           (select o.open_amount from public.open_bills('supplier', g.supplier_id) o where o.entry_id =
              (select le.id from ledger_entries le where le.reference_type = 'purchase_invoice' and le.reference_id = pi.id and le.entry_type = 'purchase_invoice' limit 1)) open
    from grns g join suppliers s on s.id = g.supplier_id left join purchase_invoices pi on pi.grn_id = g.id and pi.status = 'posted'
    where g.branch_id = p_branch and g.status <> 'voided' order by g.received_at desc limit 300) x
$$;

do $$
declare f text;
begin
  foreach f in array array['public.void_grn(uuid, text, uuid)', 'public.replace_grn(uuid, jsonb, uuid)', 'public.office_grn_detail(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
