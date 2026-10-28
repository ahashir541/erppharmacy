// The permissions engine. Must give the same answers as the database
// functions app.effective_permission / app.permission_decision
// (packages/db/supabase/migrations/..._security.sql). The counter uses this
// offline; the server re-checks with the SQL version on upload.

export type LimitKind = 'amount' | 'percent_bp' | 'count_per_day' | 'amount_per_day';
export type Decision = 'allow' | 'needs_approval' | 'deny';

export interface PermissionDef {
  code: string;
  limitKind: LimitKind | null;
}

export interface Grant {
  permissionCode: string;
  allowed: boolean;
  needsApproval: boolean;
  limitValue: number | null;
}

export interface RoleAssignment {
  roleId: string;
  branchId: string | null;      // null = every branch
  archived?: boolean;           // assignment removed
  roleArchived?: boolean;       // role itself archived
}

export interface Override extends Grant {
  branchId: string | null;      // null = every branch
}

export interface UserAccess {
  userId: string;
  isPrimaryOwner: boolean;
  status: 'invited' | 'active' | 'disabled';
  archived: boolean;
  roles: RoleAssignment[];
  rolePermissions: Record<string, Grant[]>;   // keyed by roleId
  overrides: Override[];
}

export interface Effective {
  allowed: boolean;
  needsApproval: boolean;
  limitValue: number | null;    // null = no limit; 0 = always needs approval
}

const DENY: Effective = { allowed: false, needsApproval: false, limitValue: null };

/**
 * 1. primary owner: everything, no approval, no limit
 * 2. disabled or archived person: nothing
 * 3. a per-person override for this branch, else for all branches, decides
 * 4. otherwise roles held at this branch (or all branches): allowed if any
 *    role allows; needs approval only if every allowing role needs it; the
 *    limit is the highest among allowing roles, and none if any role has none
 */
export function effectivePermission(user: UserAccess, code: string, branchId: string | null): Effective {
  if (user.isPrimaryOwner && user.status === 'active') {
    return { allowed: true, needsApproval: false, limitValue: null };
  }
  if (user.status !== 'active' || user.archived) return DENY;

  const override =
    user.overrides.find((o) => o.permissionCode === code && branchId !== null && o.branchId === branchId) ??
    user.overrides.find((o) => o.permissionCode === code && o.branchId === null);
  if (override) {
    return override.allowed
      ? { allowed: true, needsApproval: override.needsApproval, limitValue: override.limitValue }
      : DENY;
  }

  const grants = user.roles
    .filter((r) => !r.archived && !r.roleArchived && (r.branchId === null || r.branchId === branchId))
    .flatMap((r) => user.rolePermissions[r.roleId] ?? [])
    .filter((g) => g.permissionCode === code && g.allowed);
  if (grants.length === 0) return DENY;

  const unlimited = grants.some((g) => g.limitValue === null);
  return {
    allowed: true,
    needsApproval: grants.every((g) => g.needsApproval),
    limitValue: unlimited ? null : Math.max(...grants.map((g) => g.limitValue as number)),
  };
}

/**
 * One action. For a limited permission, an amount over the limit needs
 * approval. A blank (null) limit means no limit; a limit of 0 means every
 * use needs approval (D16).
 */
export function decide(user: UserAccess, def: PermissionDef, branchId: string | null, amount?: number): Decision {
  if (user.isPrimaryOwner && user.status === 'active') return 'allow';
  const e = effectivePermission(user, def.code, branchId);
  if (!e.allowed) return 'deny';
  if (e.needsApproval) return 'needs_approval';
  if (def.limitKind !== null && amount !== undefined && e.limitValue !== null && amount > e.limitValue) {
    return 'needs_approval';
  }
  return 'allow';
}
