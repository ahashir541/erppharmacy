// The counter's outbox. While offline (and online too, so there is one path), every action is a
// command with a device-made UUIDv7 and the PC's own sequence number. PowerSync uploads them and the
// server replays them in sequence (public.apply_device_commands). Stock, cash and udhaar are
// ledgers on the server, so two counters' commands can never overwrite each other.
import { formatInvoiceNumber, priceBill, settlePayments, uuidv7, type BillLineInput, type PaymentInput } from '@medflow/core';

export type CommandKind =
  | 'staff_session_start' | 'staff_session_end' | 'pin_failure'
  | 'drawer_open' | 'drawer_close' | 'sale' | 'return' | 'held_bill';

export interface Command {
  id: string;
  device_seq: number;
  kind: CommandKind;
  acting_user: string | null;
  session_id: string | null;
  created_on_device_at: string;   // ISO, UTC
  payload: Record<string, unknown>;
}

/** What a counter PC keeps between commands (stored in its local database). */
export interface CounterState {
  devicePrefix: string;          // 'KHI1-C2'
  nextCommandSeq: number;        // outbox order
  nextInvoiceSeq: number;        // bill numbers
  nextReturnSeq: number;
  staffId: string | null;        // who is signed in
  sessionId: string | null;
  drawerSessionId: string | null;
  settings: { pricesIncludeTax: boolean; roundingStep: number };
}

export interface CartLine extends BillLineInput {
  productUnitId: string;
  batchId: string;                // chosen by FEFO (packages/core allocateFefo)
}

export class Outbox {
  readonly pending: Command[] = [];
  state: CounterState;
  private clock: () => Date;
  constructor(state: CounterState, clock: () => Date = () => new Date()) {
    this.state = state;
    this.clock = clock;
  }

  private push(kind: CommandKind, payload: Record<string, unknown>): Command {
    const now = this.clock();
    const cmd: Command = {
      id: uuidv7(now.getTime()), device_seq: this.state.nextCommandSeq++, kind,
      acting_user: this.state.staffId, session_id: this.state.sessionId, created_on_device_at: now.toISOString(), payload,
    };
    this.pending.push(cmd);
    return cmd;
  }

  signIn(staffId: string): Command {
    this.state.staffId = staffId;
    this.state.sessionId = uuidv7(this.clock().getTime());
    return this.push('staff_session_start', {});
  }

  signOut(reason: 'logout' | 'idle_lock' = 'logout'): Command {
    const cmd = this.push('staff_session_end', { reason });
    this.state.staffId = null;
    this.state.sessionId = null;
    return cmd;
  }

  openDrawer(cashDrawerId: string, openingFloat: number): Command {
    this.requireStaff();
    this.state.drawerSessionId = uuidv7(this.clock().getTime());
    return this.push('drawer_open', { drawer_session_id: this.state.drawerSessionId, cash_drawer_id: cashDrawerId, opening_float: openingFloat });
  }

  /** Blind close: only the counted cash is sent; the server works out the difference. */
  closeDrawer(counted: number, denominations?: Record<string, number>): Command {
    this.requireStaff();
    if (!this.state.drawerSessionId) throw new Error('The drawer is not open.');
    const cmd = this.push('drawer_close', { drawer_session_id: this.state.drawerSessionId, counted, denominations: denominations ?? null });
    this.state.drawerSessionId = null;
    return cmd;
  }

  /**
   * A sale. The bill is computed here with the same maths the server uses, so the printed total is
   * the recorded total. Returns the command and the bill for the receipt.
   */
  sale(input: {
    lines: CartLine[]; payments: PaymentInput[]; billDiscount?: number;
    customerId?: string | null; customerAccountId?: string | null; prescriptionId?: string | null;
    approvals?: Record<string, string>;
  }) {
    this.requireStaff();
    const bill = priceBill(input.lines, { billDiscount: input.billDiscount ?? 0, ...this.state.settings });
    const settlement = settlePayments(bill.grandTotal, input.payments);
    if (settlement.udhaar > 0 && !input.customerAccountId && !input.customerId) {
      throw new Error('Choose the customer to put the rest on their khata.');
    }
    const seq = this.state.nextInvoiceSeq++;
    const id = uuidv7(this.clock().getTime());
    const invoiceNumber = formatInvoiceNumber(this.state.devicePrefix, seq);
    const command = this.push('sale', {
      id, local_seq: seq, sold_at: this.clock().toISOString(), drawer_session_id: this.state.drawerSessionId,
      customer_id: input.customerId ?? null, customer_account_id: input.customerAccountId ?? null,
      prescription_id: input.prescriptionId ?? null, bill_discount: input.billDiscount ?? 0, grand_total: bill.grandTotal,
      lines: input.lines.map((l) => ({
        id: uuidv7(this.clock().getTime()), product_unit_id: l.productUnitId, batch_id: l.batchId,
        qty: l.qty, unit_price: l.unitPrice, line_discount: l.lineDiscount ?? 0,
      })),
      payments: input.payments, approvals: input.approvals ?? {},
    });
    return { command, bill, settlement, invoiceNumber };
  }

  /** A return against the original bill (refund amounts are worked out by the server, pro rata). */
  saleReturn(input: { originalSaleId: string; lines: Array<{ saleLineId: string; qtyBase: number; restock?: boolean; condition?: string }>; refundMethod: string; reason: string; approval?: string }) {
    this.requireStaff();
    const seq = this.state.nextReturnSeq++;
    return this.push('return', {
      id: uuidv7(this.clock().getTime()), local_seq: seq, original_sale_id: input.originalSaleId, refund_method: input.refundMethod,
      reason: input.reason, approval: input.approval ?? null, drawer_session_id: this.state.drawerSessionId, returned_at: this.clock().toISOString(),
      lines: input.lines.map((l) => ({ sale_line_id: l.saleLineId, qty_base: l.qtyBase, restock: l.restock ?? true, condition: l.condition ?? 'sealed' })),
    });
  }

  holdBill(id: string, label: string, cart: unknown): Command {
    return this.push('held_bill', { id, label, cart });
  }

  /** The server confirmed these commands (applied, flagged or kept as rejected): drop them. */
  acknowledge(ids: string[]) {
    const done = new Set(ids);
    for (let i = this.pending.length - 1; i >= 0; i--) if (done.has(this.pending[i]!.id)) this.pending.splice(i, 1);
  }

  private requireStaff() {
    if (!this.state.staffId) throw new Error('A staff member must sign in with their PIN first.');
  }
}
