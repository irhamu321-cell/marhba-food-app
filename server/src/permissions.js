/*
 * Who may do what inside the admin panel.
 *
 * An admin account created before staff roles existed has an empty admin_role;
 * it is treated as super_admin so nobody is locked out by an upgrade.
 */
export const ADMIN_ROLES = ['super_admin', 'operations', 'finance', 'support'];
const ALL = ADMIN_ROLES;

export const PERMISSIONS = {
  'dashboard.view': ALL,

  'restaurants.view': ALL,
  'restaurants.manage': ['super_admin', 'operations'],       // approve, suspend, edit
  'restaurants.commission': ['super_admin', 'finance'],

  'catalog.manage': ['super_admin', 'operations'],

  'orders.view': ALL,
  'orders.cancel': ['super_admin', 'operations'],
  'orders.note': ALL,

  'refunds.view': ALL,
  'refunds.create': ['super_admin', 'finance'],

  'cod.manage': ['super_admin', 'finance'],
  'settlements.manage': ['super_admin', 'finance'],

  'customers.view': ALL,
  'customers.manage': ['super_admin', 'operations', 'support'],

  'promotions.manage': ['super_admin', 'operations'],

  'support.manage': ALL,
  'reports.view': ALL,
  'audit.view': ['super_admin', 'finance'],

  'staff.manage': ['super_admin'],
  'settings.manage': ['super_admin'],
};

export const adminRoleOf = (user) =>
  (user && user.role === 'admin' ? (user.admin_role || 'super_admin') : null);

export function can(user, permission) {
  const role = adminRoleOf(user);
  if (!role) return false;
  const allowed = PERMISSIONS[permission];
  if (!allowed) return false;
  return allowed.includes(role);
}

/** Everything this admin is allowed to do — the interface hides the rest. */
export function permissionsFor(user) {
  const role = adminRoleOf(user);
  if (!role) return [];
  return Object.keys(PERMISSIONS).filter((key) => PERMISSIONS[key].includes(role));
}
