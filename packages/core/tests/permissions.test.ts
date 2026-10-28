import { describe, expect, it } from 'vitest';
import { decide, effectivePermission, type PermissionDef, type UserAccess } from '../src/permissions.ts';

const A1 = 'branch-a1';
const A2 = 'branch-a2';
const discount: PermissionDef = { code: 'sales.discount', limitKind: 'percent_bp' };
const sell: PermissionDef = { code: 'sales.create', limitKind: null };
const viewCost: PermissionDef = { code: 'product.view_cost', limitKind: null };

function staff(overrides: Partial<UserAccess> = {}): UserAccess {
  return {
    userId: 'u1',
    isPrimaryOwner: false,
    status: 'active',
    archived: false,
    roles: [{ roleId: 'salesman', branchId: A1 }],
    rolePermissions: {
      salesman: [
        { permissionCode: 'sales.create', allowed: true, needsApproval: false, limitValue: null },
        { permissionCode: 'sales.discount', allowed: true, needsApproval: true, limitValue: null },
      ],
      manager: [{ permissionCode: 'sales.discount', allowed: true, needsApproval: false, limitValue: 1000 }],
    },
    overrides: [],
    ...overrides,
  };
}

describe('permissions engine', () => {
  it('primary owner can do everything, at any amount', () => {
    const owner = staff({ isPrimaryOwner: true, roles: [] });
    expect(decide(owner, viewCost, A1)).toBe('allow');
    expect(decide(owner, discount, A2, 9999)).toBe('allow');
  });

  it('roles apply only at their branch', () => {
    expect(decide(staff(), sell, A1)).toBe('allow');
    expect(decide(staff(), sell, A2)).toBe('deny');
  });

  it('permissions nobody granted are denied (cost is hidden from salesmen)', () => {
    expect(decide(staff(), viewCost, A1)).toBe('deny');
  });

  it('needs approval when every allowing role needs it', () => {
    expect(decide(staff(), discount, A1, 100)).toBe('needs_approval');
  });

  it('the most permissive role wins, with the highest limit', () => {
    const user = staff({ roles: [{ roleId: 'salesman', branchId: A1 }, { roleId: 'manager', branchId: null }] });
    expect(effectivePermission(user, 'sales.discount', A1)).toEqual({
      allowed: true,
      needsApproval: false,
      limitValue: 1000,
    });
    expect(decide(user, discount, A1, 500)).toBe('allow');
    expect(decide(user, discount, A1, 1000)).toBe('allow');
    expect(decide(user, discount, A1, 1001)).toBe('needs_approval');
  });

  it('a limited permission with no limit set needs approval (fail closed)', () => {
    const user = staff({
      roles: [{ roleId: 'x', branchId: null }],
      rolePermissions: { x: [{ permissionCode: 'sales.discount', allowed: true, needsApproval: false, limitValue: null }] },
    });
    expect(decide(user, discount, A1, 1)).toBe('needs_approval');
    expect(decide(user, discount, A1)).toBe('allow'); // no amount = just "may they discount at all"
  });

  it('branch-specific override beats all-branch override, which beats roles', () => {
    const user = staff({
      overrides: [
        { permissionCode: 'sales.create', branchId: null, allowed: false, needsApproval: false, limitValue: null },
        { permissionCode: 'sales.create', branchId: A2, allowed: true, needsApproval: false, limitValue: null },
      ],
    });
    expect(decide(user, sell, A1)).toBe('deny');
    expect(decide(user, sell, A2)).toBe('allow');
  });

  it('disabled, archived or not-yet-active people can do nothing', () => {
    expect(decide(staff({ status: 'disabled' }), sell, A1)).toBe('deny');
    expect(decide(staff({ archived: true }), sell, A1)).toBe('deny');
    expect(decide(staff({ status: 'invited' }), sell, A1)).toBe('deny');
  });

  it('archived roles and removed assignments grant nothing', () => {
    expect(decide(staff({ roles: [{ roleId: 'salesman', branchId: A1, roleArchived: true }] }), sell, A1)).toBe('deny');
    expect(decide(staff({ roles: [{ roleId: 'salesman', branchId: A1, archived: true }] }), sell, A1)).toBe('deny');
  });
});
