// Microsoft Graph user properties offered by the pivot-attribute type-ahead.
// Nested paths use '/' (e.g. onPremisesExtensionAttributes/extensionAttribute9)
// — the server $selects the first segment and resolves the rest.

/** Everyday pivots — the dropdown's default entries, [path, label]. */
export const COMMON_ATTRIBUTES = [
  ['department', 'Department'],
  ['jobTitle', 'Job title'],
  ['companyName', 'Company'],
  ['officeLocation', 'Office'],
  ['city', 'City'],
  ['state', 'State'],
  ['employeeType', 'Employee type']
];

const EXTENSION_ATTRIBUTES = Array.from(
  { length: 15 },
  (_, i) => `onPremisesExtensionAttributes/extensionAttribute${i + 1}`
);

/** Full catalog (commons included) — kept alphabetical for scanability. */
export const ATTRIBUTE_CATALOG = [
  'accountEnabled',
  'ageGroup',
  'city',
  'companyName',
  'country',
  'creationType',
  'department',
  'displayName',
  'employeeHireDate',
  'employeeId',
  'employeeOrgData/costCenter',
  'employeeOrgData/division',
  'employeeType',
  'externalUserState',
  'givenName',
  'jobTitle',
  'mail',
  'mailNickname',
  'mobilePhone',
  'officeLocation',
  'onPremisesDistinguishedName',
  'onPremisesDomainName',
  'onPremisesImmutableId',
  'onPremisesSamAccountName',
  'onPremisesSecurityIdentifier',
  'onPremisesSyncEnabled',
  'onPremisesUserPrincipalName',
  'postalCode',
  'preferredLanguage',
  'state',
  'streetAddress',
  'surname',
  'usageLocation',
  'userPrincipalName',
  'userType',
  ...EXTENSION_ATTRIBUTES
];

/**
 * Type-ahead filter: case-insensitive substring over the whole path, so
 * "ext9", "extensionAttribute9" and "onPremises/ext" all find their target.
 */
export function filterAttributes(term, limit = 14) {
  if (!term) {
    const commons = COMMON_ATTRIBUTES.map(([path]) => path);
    return [...commons, ...ATTRIBUTE_CATALOG.filter((a) => !commons.includes(a))].slice(0, limit);
  }
  const needles = term.toLowerCase().split(/[\s/]+/).filter(Boolean);
  return ATTRIBUTE_CATALOG
    .filter((a) => {
      const hay = a.toLowerCase();
      return needles.every((n) => hay.includes(n));
    })
    .slice(0, limit);
}
