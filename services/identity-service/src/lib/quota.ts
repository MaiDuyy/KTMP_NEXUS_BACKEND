// services/identity-service/src/lib/quota.ts

export const getQuotaByRole = (role: string) => {
  switch (role) {
    case 'SUPER_ADMIN':
    case 'WORKSPACE_MANAGER': // Org creators are managers/superadmins
      return 999;
    case 'ADMIN':
      return 100;
    default:
      return 10;
  }
};
