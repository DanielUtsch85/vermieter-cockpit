import type pg from 'pg';

/**
 * §58K (VC-X-34, K4): since VC-X-34 `POST /acquisitions/{id}/confirm` refuses an Acquisition without
 * `economicTransferDate` (`422 CONFIRMATION_BLOCKED`, `TRANSFER_DATE_MISSING`). An Acquisition confirmed before that
 * (legacy data) keeps the date unset for good until the follow-up row of the backlog records it. Tests of such legacy
 * data confirm past the repository, as a confirmation before VC-X-34 did: the database's guard of 0022 (requirements 1–6
 * on the transfer date) still holds, the date itself is not one of its requirements. Test support only.
 */
export async function confirmAsBeforeVcX34(pool: pg.Pool, acquisitionId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), updated_at = now(), version = version + 1
      WHERE id = $1 AND status = 'DRAFT' AND economic_transfer_date IS NULL`,
    [acquisitionId],
  );
  if (rowCount !== 1) throw new Error(`not an undated DRAFT: ${acquisitionId}`);
}
