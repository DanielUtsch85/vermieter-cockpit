/**
 * The filters and the page of the transaction list, in the URL and in the request (ui-guide.md §3.2: list filters and
 * page numbers in the URL; §6.3: only the parameters `GET /transactions` supports, api-design.md §30.1, §58W).
 *
 * The URL uses the API's own names, so a shared link and the request it makes say the same. Only these names are read
 * from the URL and sent; any other parameter of the URL is ignored, never forwarded (the backend refuses unknown ones).
 * The values are passed on as they are: the backend is the judge of a value (ui-guide.md §6.3), and a value it refuses
 * comes back as a field error bound to the filter that holds it. No value of the list is free text, an IBAN or a token
 * (§3.2): ids, codes, statuses, dates and `true`.
 */
export const FILTER_NAMES = [
  'financialAccountId',
  'status',
  'provenance',
  'reviewable',
  'current',
  'propertyReferenceId',
  'financialCategoryCode',
  'bookingDateFrom',
  'bookingDateTo',
] as const;

export type FilterName = (typeof FILTER_NAMES)[number];

/** The parameters a field error of the list can name: the filters and the page (ui-guide.md §7.4, §90). */
export const LIST_FIELD_NAMES: readonly string[] = [...FILTER_NAMES, 'page', 'pageSize'];

/** `pageSize` of the API: default 50, at most 200 (§30.1, ui-guide.md §6.3). */
export const DEFAULT_PAGE_SIZE = '50';
export const PAGE_SIZES: readonly string[] = ['25', '50', '100', '200'];

export interface ListParams {
  readonly filters: Readonly<Partial<Record<FilterName, string>>>;
  /** As in the URL; the backend checks the range (`page` ≥ 1, `pageSize` 1–200). */
  readonly page: string;
  readonly pageSize: string;
}

type Entries = Iterable<readonly [string, unknown]>;

/** Every value of a name, trimmed, empty ones dropped; repeated names (a form's checkboxes) become the API's comma list. */
function collect(entries: Entries): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const [name, value] of entries) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text === '') continue;
    values.set(name, [...(values.get(name) ?? []), text]);
  }
  return values;
}

function fromEntries(entries: Entries, keepPage: boolean): ListParams {
  const values = collect(entries);
  const filters: Partial<Record<FilterName, string>> = {};
  for (const name of FILTER_NAMES) {
    const list = values.get(name);
    if (list !== undefined) filters[name] = list.join(',');
  }
  return {
    filters,
    page: keepPage ? (values.get('page')?.[0] ?? '1') : '1',
    pageSize: values.get('pageSize')?.[0] ?? DEFAULT_PAGE_SIZE,
  };
}

/** The list's parameters from the URL's search part (`?status=IMPORTED&page=2`). */
export function readListParams(search: string): ListParams {
  return fromEntries(new URLSearchParams(search), true);
}

/** The parameters of a submitted filter form: a new filter starts on page 1 and keeps the chosen page size. */
export function paramsFromForm(entries: Entries): ListParams {
  return fromEntries(entries, false);
}

/** The query of `GET /transactions`: the filters in a fixed order, then page and page size (also the query key). */
export function toApiQuery(params: ListParams): Readonly<Record<string, string>> {
  const query: Record<string, string> = {};
  for (const name of FILTER_NAMES) {
    const value = params.filters[name];
    if (value !== undefined) query[name] = value;
  }
  query['page'] = params.page;
  query['pageSize'] = params.pageSize;
  return query;
}

/** The URL's search part for the parameters; the defaults (page 1, page size 50) are left out. */
export function toSearch(params: ListParams): string {
  const query = new URLSearchParams();
  for (const name of FILTER_NAMES) {
    const value = params.filters[name];
    if (value !== undefined) query.append(name, value);
  }
  if (params.page !== '1') query.append('page', params.page);
  if (params.pageSize !== DEFAULT_PAGE_SIZE) query.append('pageSize', params.pageSize);
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

export function withPage(params: ListParams, page: number): ListParams {
  return { ...params, page: String(page) };
}

export function hasFilters(params: ListParams): boolean {
  return FILTER_NAMES.some((name) => params.filters[name] !== undefined);
}

/** The values of a comma-list filter (`status`, `provenance`). */
export function filterValues(params: ListParams, name: 'status' | 'provenance'): readonly string[] {
  return params.filters[name]?.split(',') ?? [];
}

/** Pages of a list with `total` entries (counts, not money). At least one, so "Seite 1 von 1" for an empty list. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
