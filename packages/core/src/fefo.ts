// First-expiry-first-out: sell from the batch that expires first. Expired
// and blocked (recalled) batches are never offered.

export interface BatchStock {
  batchId: string;
  expiryDate: string;   // 'YYYY-MM-DD'
  qtyBase: number;      // on the shelf at this branch
  blocked: boolean;
}

export interface Allocation {
  batchId: string;
  qtyBase: number;
}

export function allocateFefo(
  batches: BatchStock[],
  qtyBase: number,
  today: string,
): { allocations: Allocation[]; shortBy: number } {
  if (!Number.isSafeInteger(qtyBase) || qtyBase <= 0) throw new RangeError('quantity must be a whole number above 0');
  const sellable = batches
    .filter((b) => !b.blocked && b.qtyBase > 0 && b.expiryDate >= today)
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.batchId.localeCompare(b.batchId));
  const allocations: Allocation[] = [];
  let left = qtyBase;
  for (const b of sellable) {
    if (left === 0) break;
    const take = Math.min(left, b.qtyBase);
    allocations.push({ batchId: b.batchId, qtyBase: take });
    left -= take;
  }
  return { allocations, shortBy: left };
}
