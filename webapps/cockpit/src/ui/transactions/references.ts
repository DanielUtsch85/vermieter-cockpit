import type { FinancialAccountDto, FinancialCategoryDto, PageDto, PropertyReferenceDto } from '../../api/transactions';
import type { Loadable } from '../RealmChoice';

/** The lists that name the ids of a Transaction (ui-guide.md §6.3: "Konto-ID/aufgelöstes Label"), each in its state. */
export interface References {
  readonly accounts: Loadable<PageDto<FinancialAccountDto>>;
  readonly properties: Loadable<PageDto<PropertyReferenceDto>>;
  readonly categories: Loadable<readonly FinancialCategoryDto[]>;
}

export function accountName(references: References, id: string): string | undefined {
  return references.accounts.status === 'success' ? references.accounts.data.items.find((a) => a.financialAccountId === id)?.displayName : undefined;
}

/** A PropertyReference's cached display name (api-design.md §23.3); undefined when unknown or without a name. */
export function propertyName(references: References, id: string): string | undefined {
  if (references.properties.status !== 'success') return undefined;
  return references.properties.data.items.find((p) => p.propertyReferenceId === id)?.displayName ?? undefined;
}

export function categoryName(references: References, code: string): string | undefined {
  return references.categories.status === 'success' ? references.categories.data.find((c) => c.code === code)?.name : undefined;
}
