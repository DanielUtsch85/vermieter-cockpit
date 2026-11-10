import { describe, expect, it } from 'vitest';
import { FILTER_NAMES, filterValues, hasFilters, pageCount, paramsFromForm, readListParams, toApiQuery, toSearch, withPage } from './list-params';

const ACCOUNT = '0b8f2c1e-3d4a-4b5c-8d6e-7f8091a2b3c4';

describe('the list filters in the URL and in the request (ui-guide.md §3.2, §6.3, §58W)', () => {
  it('the filters are exactly the parameters GET /transactions supports (api-design.md §30.1)', () => {
    expect(FILTER_NAMES).toEqual([
      'financialAccountId',
      'status',
      'provenance',
      'reviewable',
      'current',
      'propertyReferenceId',
      'financialCategoryCode',
      'bookingDateFrom',
      'bookingDateTo',
    ]);
  });

  it('without a search part: no filter, page 1, page size 50, and only page and page size are sent', () => {
    const params = readListParams('');
    expect(params).toEqual({ filters: {}, page: '1', pageSize: '50' });
    expect(toApiQuery(params)).toEqual({ page: '1', pageSize: '50' });
    expect(toSearch(params)).toBe('');
    expect(hasFilters(params)).toBe(false);
  });

  it('unknown URL parameters are never sent: no q, sort, counterparty or unreconciled (ui-guide.md §6.3)', () => {
    const params = readListParams('?q=Miete&sort=amount&counterparty=X&unreconciled=true&token=abc&status=IMPORTED');
    expect(Object.keys(toApiQuery(params))).toEqual(['status', 'page', 'pageSize']);
    expect(toSearch(params)).toBe('?status=IMPORTED');
  });

  it('a round trip URL → request → URL keeps every filter, in a fixed order', () => {
    const search = `?bookingDateTo=2026-12-31&status=IMPORTED%2CUNREVIEWED&financialAccountId=${ACCOUNT}&current=true&page=3&pageSize=200`;
    const params = readListParams(search);
    expect(toApiQuery(params)).toEqual({
      financialAccountId: ACCOUNT,
      status: 'IMPORTED,UNREVIEWED',
      current: 'true',
      bookingDateTo: '2026-12-31',
      page: '3',
      pageSize: '200',
    });
    expect(readListParams(toSearch(params))).toEqual(params);
    expect(toSearch(params)).toBe(`?financialAccountId=${ACCOUNT}&status=IMPORTED%2CUNREVIEWED&current=true&bookingDateTo=2026-12-31&page=3&pageSize=200`);
  });

  it('repeated names (checkboxes of a form) become the comma list of the API, empty values are dropped', () => {
    const params = readListParams('?status=IMPORTED&status=CONFIRMED&provenance=&bookingDateFrom=%20');
    expect(params.filters).toEqual({ status: 'IMPORTED,CONFIRMED' });
    expect(filterValues(params, 'status')).toEqual(['IMPORTED', 'CONFIRMED']);
    expect(filterValues(params, 'provenance')).toEqual([]);
  });

  it('a value is passed on as it is; the backend judges it and its refusal is bound to the filter', () => {
    expect(toApiQuery(readListParams('?status=FOO&page=0&pageSize=500'))).toEqual({ status: 'FOO', page: '0', pageSize: '500' });
  });

  it('a submitted filter form starts on page 1 and keeps the page size', () => {
    const params = paramsFromForm([
      ['financialAccountId', ''],
      ['status', 'IMPORTED'],
      ['status', 'UNREVIEWED'],
      ['reviewable', 'true'],
      ['page', '7'],
      ['pageSize', '100'],
      ['file', new Blob()],
    ]);
    expect(params).toEqual({ filters: { status: 'IMPORTED,UNREVIEWED', reviewable: 'true' }, page: '1', pageSize: '100' });
  });

  it('paging keeps the filters; counts of pages come from total', () => {
    const params = withPage(readListParams('?provenance=BANK_CSV'), 2);
    expect(toSearch(params)).toBe('?provenance=BANK_CSV&page=2');
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(230, 25)).toBe(10);
  });
});
