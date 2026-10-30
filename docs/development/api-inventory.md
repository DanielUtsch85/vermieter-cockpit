# API inventory (generated)

Every route the DE backend registers, read from `services/de-backend/src/api` by `scripts/api-inventory.mjs`.
Regenerate with `yarn api:inventory`; CI runs `yarn api:inventory --check`. Do not edit by hand.

Implemented routes only: a route in `docs/architecture/api-design.md` that is not listed here is specified, not available.
Contracts, payloads and error codes are in `api-design.md`; the business routes need `Authorization: Bearer <MRE token>` and
`organizationid: <mreRealmId>` (`mre-integration.md` §47.2).

Routes: 139.

| Method | Path |
|---|---|
| GET | `/api/v1/acquisitions` |
| POST | `/api/v1/acquisitions` |
| GET | `/api/v1/acquisitions/:acquisitionId` |
| GET | `/api/v1/acquisitions/:acquisitionId/anschaffungsnahe-herstellungskosten` |
| POST | `/api/v1/acquisitions/:acquisitionId/cancel` |
| POST | `/api/v1/acquisitions/:acquisitionId/confirm` |
| GET | `/api/v1/acquisitions/:acquisitionId/costs` |
| POST | `/api/v1/acquisitions/:acquisitionId/costs` |
| POST | `/api/v1/acquisitions/:acquisitionId/costs/:costId/void` |
| POST | `/api/v1/acquisitions/:acquisitionId/land-building-allocation` |
| GET | `/api/v1/acquisitions/:acquisitionId/land-building-allocations` |
| GET | `/api/v1/acquisitions/:acquisitionId/owner-allocation` |
| GET | `/api/v1/acquisitions/:acquisitionId/payments` |
| POST | `/api/v1/acquisitions/:acquisitionId/payments` |
| POST | `/api/v1/acquisitions/:acquisitionId/payments/:paymentId/unlink` |
| GET | `/api/v1/financial-accounts` |
| POST | `/api/v1/financial-accounts` |
| GET | `/api/v1/financial-accounts/:financialAccountId` |
| POST | `/api/v1/financial-accounts/:financialAccountId/close` |
| GET | `/api/v1/financial-categories` |
| GET | `/api/v1/financial-categories/:code` |
| GET | `/api/v1/health` |
| GET | `/api/v1/imports/:importBatchId` |
| GET | `/api/v1/imports/:importBatchId/review-items` |
| POST | `/api/v1/imports/:importBatchId/review-items/:reviewItemId/resolve` |
| POST | `/api/v1/imports/bank-transactions` |
| GET | `/api/v1/loans` |
| POST | `/api/v1/loans` |
| GET | `/api/v1/loans/:loanId` |
| GET | `/api/v1/loans/:loanId/allocations` |
| POST | `/api/v1/loans/:loanId/allocations` |
| POST | `/api/v1/loans/:loanId/allocations/:allocationSetId/void` |
| POST | `/api/v1/loans/:loanId/amend` |
| GET | `/api/v1/loans/:loanId/balance-statements` |
| POST | `/api/v1/loans/:loanId/balance-statements` |
| POST | `/api/v1/loans/:loanId/balance-statements/:statementId/void` |
| POST | `/api/v1/loans/:loanId/close` |
| GET | `/api/v1/loans/:loanId/payment-proposal` |
| GET | `/api/v1/loans/:loanId/payments` |
| GET | `/api/v1/loans/:loanId/remaining-debt` |
| GET | `/api/v1/loans/:loanId/schedule` |
| GET | `/api/v1/loans/:loanId/terms` |
| POST | `/api/v1/loans/:loanId/terms` |
| POST | `/api/v1/loans/:loanId/terms/:termsId/void` |
| POST | `/api/v1/loans/:loanId/void` |
| POST | `/api/v1/ownerships` |
| GET | `/api/v1/ownerships/:ownershipId` |
| POST | `/api/v1/ownerships/:ownershipId/close` |
| POST | `/api/v1/ownerships/:ownershipId/void` |
| GET | `/api/v1/parties` |
| POST | `/api/v1/parties` |
| GET | `/api/v1/parties/:partyId` |
| POST | `/api/v1/parties/:partyId/amend` |
| POST | `/api/v1/parties/:partyId/deactivate` |
| GET | `/api/v1/parties/:partyId/external-references` |
| POST | `/api/v1/parties/:partyId/external-references` |
| POST | `/api/v1/parties/:partyId/external-references/:externalReferenceId/end` |
| GET | `/api/v1/property-references` |
| GET | `/api/v1/property-references/:propertyReferenceId` |
| GET | `/api/v1/property-references/:propertyReferenceId/acquisitions` |
| GET | `/api/v1/property-references/:propertyReferenceId/loans` |
| POST | `/api/v1/property-references/:propertyReferenceId/ownership-changes` |
| GET | `/api/v1/property-references/:propertyReferenceId/ownerships` |
| POST | `/api/v1/property-references/:propertyReferenceId/refresh` |
| GET | `/api/v1/property-references/:propertyReferenceId/tax-meanings` |
| GET | `/api/v1/property-references/:propertyReferenceId/tax-years/:year` |
| GET | `/api/v1/property-references/:propertyReferenceId/transactions` |
| GET | `/api/v1/property-references/:propertyReferenceId/weg-memberships` |
| POST | `/api/v1/property-references/link` |
| GET | `/api/v1/rent-reconciliations` |
| POST | `/api/v1/rent-reconciliations` |
| GET | `/api/v1/rent-reconciliations/:reconciliationId` |
| POST | `/api/v1/rent-reconciliations/:reconciliationId/confirm` |
| POST | `/api/v1/rent-reconciliations/:reconciliationId/reject` |
| POST | `/api/v1/rent-reconciliations/:reconciliationId/release` |
| GET | `/api/v1/rent-reconciliations/split-proposal` |
| POST | `/api/v1/rent-reconciliations/suggest` |
| GET | `/api/v1/rent-reconciliations/terms/:mreTenantId/:mreRentTerm` |
| GET | `/api/v1/rental-contract-references` |
| POST | `/api/v1/rental-contract-references` |
| GET | `/api/v1/rental-contract-references/:rentalContractReferenceId` |
| POST | `/api/v1/rental-contract-references/:rentalContractReferenceId/amend` |
| GET | `/api/v1/security-deposits` |
| POST | `/api/v1/security-deposits` |
| GET | `/api/v1/security-deposits/:depositId/tax-meaning` |
| GET | `/api/v1/security-deposits/:securityDepositId` |
| POST | `/api/v1/security-deposits/:securityDepositId/amend` |
| POST | `/api/v1/security-deposits/:securityDepositId/close` |
| POST | `/api/v1/security-deposits/:securityDepositId/reopen` |
| POST | `/api/v1/security-deposits/:securityDepositId/void` |
| GET | `/api/v1/tax-classifications` |
| POST | `/api/v1/tax-classifications` |
| GET | `/api/v1/tax-classifications/:classificationId` |
| GET | `/api/v1/tax-rules` |
| GET | `/api/v1/tax-rules/:ruleCode` |
| GET | `/api/v1/transaction-splits/:splitId/tax-meaning` |
| GET | `/api/v1/transactions` |
| POST | `/api/v1/transactions` |
| GET | `/api/v1/transactions/:transactionId` |
| POST | `/api/v1/transactions/:transactionId/amend` |
| POST | `/api/v1/transactions/:transactionId/confirm` |
| POST | `/api/v1/transactions/:transactionId/correct` |
| GET | `/api/v1/transactions/:transactionId/hausgeld-proposal` |
| POST | `/api/v1/transactions/:transactionId/ignore` |
| GET | `/api/v1/transactions/:transactionId/rent-reconciliations` |
| POST | `/api/v1/transactions/:transactionId/restore` |
| POST | `/api/v1/transactions/:transactionId/reverse` |
| GET | `/api/v1/transactions/:transactionId/settlement-proposal` |
| PUT | `/api/v1/transactions/:transactionId/splits` |
| GET | `/api/v1/weg-annual-statements/:statementId` |
| PUT | `/api/v1/weg-annual-statements/:statementId` |
| GET | `/api/v1/weg-annual-statements/:statementId/comparison` |
| POST | `/api/v1/weg-annual-statements/:statementId/confirm` |
| POST | `/api/v1/weg-annual-statements/:statementId/void` |
| GET | `/api/v1/weg-economic-plans/:planId` |
| POST | `/api/v1/weg-economic-plans/:planId/void` |
| GET | `/api/v1/weg-memberships/:membershipId` |
| POST | `/api/v1/weg-memberships/:membershipId/amend` |
| GET | `/api/v1/weg-memberships/:membershipId/annual-statements` |
| POST | `/api/v1/weg-memberships/:membershipId/annual-statements` |
| GET | `/api/v1/weg-memberships/:membershipId/economic-plans` |
| POST | `/api/v1/weg-memberships/:membershipId/economic-plans` |
| POST | `/api/v1/weg-memberships/:membershipId/end` |
| GET | `/api/v1/weg-memberships/:membershipId/special-assessments` |
| POST | `/api/v1/weg-memberships/:membershipId/special-assessments` |
| POST | `/api/v1/weg-memberships/:membershipId/void` |
| GET | `/api/v1/weg-special-assessments/:assessmentId` |
| POST | `/api/v1/weg-special-assessments/:assessmentId/amend` |
| PUT | `/api/v1/weg-special-assessments/:assessmentId/uses` |
| POST | `/api/v1/weg-special-assessments/:assessmentId/void` |
| GET | `/api/v1/wegs` |
| POST | `/api/v1/wegs` |
| GET | `/api/v1/wegs/:wegId` |
| POST | `/api/v1/wegs/:wegId/amend` |
| GET | `/api/v1/wegs/:wegId/memberships` |
| POST | `/api/v1/wegs/:wegId/memberships` |
| POST | `/api/v1/wegs/:wegId/void` |
| GET | `/health/live` |
| GET | `/health/ready` |

## By module

### `services/de-backend/src/api/acquisition-costs.ts`

- GET `/api/v1/acquisitions/:acquisitionId/costs`
- POST `/api/v1/acquisitions/:acquisitionId/costs`
- POST `/api/v1/acquisitions/:acquisitionId/costs/:costId/void`
- GET `/api/v1/acquisitions/:acquisitionId/payments`
- POST `/api/v1/acquisitions/:acquisitionId/payments`
- POST `/api/v1/acquisitions/:acquisitionId/payments/:paymentId/unlink`

### `services/de-backend/src/api/acquisitions.ts`

- GET `/api/v1/acquisitions`
- POST `/api/v1/acquisitions`
- GET `/api/v1/acquisitions/:acquisitionId`
- POST `/api/v1/acquisitions/:acquisitionId/cancel`
- POST `/api/v1/acquisitions/:acquisitionId/confirm`
- GET `/api/v1/property-references/:propertyReferenceId/acquisitions`

### `services/de-backend/src/api/app.ts`

- GET `/api/v1/health`
- GET `/health/live`
- GET `/health/ready`

### `services/de-backend/src/api/financial-accounts.ts`

- GET `/api/v1/financial-accounts`
- POST `/api/v1/financial-accounts`
- GET `/api/v1/financial-accounts/:financialAccountId`
- POST `/api/v1/financial-accounts/:financialAccountId/close`

### `services/de-backend/src/api/financial-categories.ts`

- GET `/api/v1/financial-categories`
- GET `/api/v1/financial-categories/:code`

### `services/de-backend/src/api/imports.ts`

- GET `/api/v1/imports/:importBatchId`
- GET `/api/v1/imports/:importBatchId/review-items`
- POST `/api/v1/imports/:importBatchId/review-items/:reviewItemId/resolve`
- POST `/api/v1/imports/bank-transactions`

### `services/de-backend/src/api/land-building-allocations.ts`

- POST `/api/v1/acquisitions/:acquisitionId/land-building-allocation`
- GET `/api/v1/acquisitions/:acquisitionId/land-building-allocations`

### `services/de-backend/src/api/loan-allocations.ts`

- GET `/api/v1/loans/:loanId/allocations`
- POST `/api/v1/loans/:loanId/allocations`
- POST `/api/v1/loans/:loanId/allocations/:allocationSetId/void`
- GET `/api/v1/property-references/:propertyReferenceId/loans`

### `services/de-backend/src/api/loan-debt.ts`

- GET `/api/v1/loans/:loanId/balance-statements`
- POST `/api/v1/loans/:loanId/balance-statements`
- POST `/api/v1/loans/:loanId/balance-statements/:statementId/void`
- GET `/api/v1/loans/:loanId/payments`
- GET `/api/v1/loans/:loanId/remaining-debt`

### `services/de-backend/src/api/loan-terms.ts`

- GET `/api/v1/loans/:loanId/payment-proposal`
- GET `/api/v1/loans/:loanId/schedule`
- GET `/api/v1/loans/:loanId/terms`
- POST `/api/v1/loans/:loanId/terms`
- POST `/api/v1/loans/:loanId/terms/:termsId/void`

### `services/de-backend/src/api/loans.ts`

- GET `/api/v1/loans`
- POST `/api/v1/loans`
- GET `/api/v1/loans/:loanId`
- POST `/api/v1/loans/:loanId/amend`
- POST `/api/v1/loans/:loanId/close`
- POST `/api/v1/loans/:loanId/void`

### `services/de-backend/src/api/owner-allocation.ts`

- GET `/api/v1/acquisitions/:acquisitionId/owner-allocation`

### `services/de-backend/src/api/ownerships.ts`

- POST `/api/v1/ownerships`
- GET `/api/v1/ownerships/:ownershipId`
- POST `/api/v1/ownerships/:ownershipId/close`
- POST `/api/v1/ownerships/:ownershipId/void`
- POST `/api/v1/property-references/:propertyReferenceId/ownership-changes`
- GET `/api/v1/property-references/:propertyReferenceId/ownerships`

### `services/de-backend/src/api/parties.ts`

- GET `/api/v1/parties`
- POST `/api/v1/parties`
- GET `/api/v1/parties/:partyId`
- POST `/api/v1/parties/:partyId/amend`
- POST `/api/v1/parties/:partyId/deactivate`

### `services/de-backend/src/api/party-external-references.ts`

- GET `/api/v1/parties/:partyId/external-references`
- POST `/api/v1/parties/:partyId/external-references`
- POST `/api/v1/parties/:partyId/external-references/:externalReferenceId/end`

### `services/de-backend/src/api/property-references.ts`

- GET `/api/v1/property-references`
- GET `/api/v1/property-references/:propertyReferenceId`
- POST `/api/v1/property-references/:propertyReferenceId/refresh`
- POST `/api/v1/property-references/link`

### `services/de-backend/src/api/rent-reconciliations.ts`

- GET `/api/v1/rent-reconciliations`
- POST `/api/v1/rent-reconciliations`
- GET `/api/v1/rent-reconciliations/:reconciliationId`
- POST `/api/v1/rent-reconciliations/:reconciliationId/confirm`
- POST `/api/v1/rent-reconciliations/:reconciliationId/reject`
- POST `/api/v1/rent-reconciliations/:reconciliationId/release`
- GET `/api/v1/rent-reconciliations/split-proposal`
- POST `/api/v1/rent-reconciliations/suggest`
- GET `/api/v1/rent-reconciliations/terms/:mreTenantId/:mreRentTerm`
- GET `/api/v1/transactions/:transactionId/rent-reconciliations`

### `services/de-backend/src/api/rental-contract-references.ts`

- GET `/api/v1/rental-contract-references`
- POST `/api/v1/rental-contract-references`
- GET `/api/v1/rental-contract-references/:rentalContractReferenceId`
- POST `/api/v1/rental-contract-references/:rentalContractReferenceId/amend`

### `services/de-backend/src/api/security-deposits.ts`

- GET `/api/v1/security-deposits`
- POST `/api/v1/security-deposits`
- GET `/api/v1/security-deposits/:securityDepositId`
- POST `/api/v1/security-deposits/:securityDepositId/amend`
- POST `/api/v1/security-deposits/:securityDepositId/close`
- POST `/api/v1/security-deposits/:securityDepositId/reopen`
- POST `/api/v1/security-deposits/:securityDepositId/void`

### `services/de-backend/src/api/tax-classifications.ts`

- GET `/api/v1/acquisitions/:acquisitionId/anschaffungsnahe-herstellungskosten`
- GET `/api/v1/property-references/:propertyReferenceId/tax-meanings`
- GET `/api/v1/property-references/:propertyReferenceId/tax-years/:year`
- GET `/api/v1/security-deposits/:depositId/tax-meaning`
- GET `/api/v1/tax-classifications`
- POST `/api/v1/tax-classifications`
- GET `/api/v1/tax-classifications/:classificationId`
- GET `/api/v1/tax-rules`
- GET `/api/v1/tax-rules/:ruleCode`
- GET `/api/v1/transaction-splits/:splitId/tax-meaning`

### `services/de-backend/src/api/transaction-lifecycle.ts`

- POST `/api/v1/transactions/:transactionId/amend`
- POST `/api/v1/transactions/:transactionId/confirm`
- POST `/api/v1/transactions/:transactionId/correct`
- POST `/api/v1/transactions/:transactionId/ignore`
- POST `/api/v1/transactions/:transactionId/restore`
- POST `/api/v1/transactions/:transactionId/reverse`

### `services/de-backend/src/api/transaction-splits.ts`

- PUT `/api/v1/transactions/:transactionId/splits`

### `services/de-backend/src/api/transactions.ts`

- GET `/api/v1/property-references/:propertyReferenceId/transactions`
- GET `/api/v1/transactions`
- POST `/api/v1/transactions`
- GET `/api/v1/transactions/:transactionId`

### `services/de-backend/src/api/weg-annual-statements.ts`

- GET `/api/v1/transactions/:transactionId/settlement-proposal`
- GET `/api/v1/weg-annual-statements/:statementId`
- PUT `/api/v1/weg-annual-statements/:statementId`
- GET `/api/v1/weg-annual-statements/:statementId/comparison`
- POST `/api/v1/weg-annual-statements/:statementId/confirm`
- POST `/api/v1/weg-annual-statements/:statementId/void`
- GET `/api/v1/weg-memberships/:membershipId/annual-statements`
- POST `/api/v1/weg-memberships/:membershipId/annual-statements`

### `services/de-backend/src/api/weg-economic-plans.ts`

- GET `/api/v1/transactions/:transactionId/hausgeld-proposal`
- GET `/api/v1/weg-economic-plans/:planId`
- POST `/api/v1/weg-economic-plans/:planId/void`
- GET `/api/v1/weg-memberships/:membershipId/economic-plans`
- POST `/api/v1/weg-memberships/:membershipId/economic-plans`

### `services/de-backend/src/api/weg-special-assessments.ts`

- GET `/api/v1/weg-memberships/:membershipId/special-assessments`
- POST `/api/v1/weg-memberships/:membershipId/special-assessments`
- GET `/api/v1/weg-special-assessments/:assessmentId`
- POST `/api/v1/weg-special-assessments/:assessmentId/amend`
- PUT `/api/v1/weg-special-assessments/:assessmentId/uses`
- POST `/api/v1/weg-special-assessments/:assessmentId/void`

### `services/de-backend/src/api/wegs.ts`

- GET `/api/v1/property-references/:propertyReferenceId/weg-memberships`
- GET `/api/v1/weg-memberships/:membershipId`
- POST `/api/v1/weg-memberships/:membershipId/amend`
- POST `/api/v1/weg-memberships/:membershipId/end`
- POST `/api/v1/weg-memberships/:membershipId/void`
- GET `/api/v1/wegs`
- POST `/api/v1/wegs`
- GET `/api/v1/wegs/:wegId`
- POST `/api/v1/wegs/:wegId/amend`
- GET `/api/v1/wegs/:wegId/memberships`
- POST `/api/v1/wegs/:wegId/memberships`
- POST `/api/v1/wegs/:wegId/void`
