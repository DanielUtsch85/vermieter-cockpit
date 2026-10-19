import express, { type Router } from 'express';
import {
  CATEGORY_CODE,
  FinancialCategoryNotFoundError,
  type FinancialCategory,
  type GetFinancialCategory,
  type ListFinancialCategories,
} from '../application/index.js';
import { sendError } from './errors.js';
import { sendValidationError } from './validation.js';

export interface FinancialCategoryQueries {
  readonly list: ListFinancialCategories;
  readonly get: GetFinancialCategory;
}

/** Financial Categories API (api-design.md §36): read-only reference data. */
export function financialCategoryRoutes(queries: FinancialCategoryQueries): Router {
  const router = express.Router();

  router.get('/financial-categories', (_req, res, next) => {
    queries
      .list()
      .then((categories) => {
        res.json({ items: categories.map(toDto) });
      })
      .catch(next);
  });

  router.get('/financial-categories/:code', (req, res, next) => {
    const code = req.params['code'] ?? '';
    if (!CATEGORY_CODE.test(code)) {
      sendValidationError(res, [{ field: 'code', code: 'INVALID_FORMAT' }]);
      return;
    }
    queries
      .get(code)
      .then((category) => {
        res.json(toDto(category));
      })
      .catch((error: unknown) => {
        if (error instanceof FinancialCategoryNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'FinancialCategory not found.', { code });
        } else {
          next(error);
        }
      });
  });

  return router;
}

function toDto(category: FinancialCategory) {
  return { code: category.code, name: category.name, categoryType: category.categoryType, active: category.active };
}
