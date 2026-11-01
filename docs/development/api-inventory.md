# API inventory (generated)

Every route the DE backend registers, read from the router of the app as `createApp` builds it
(`services/de-backend/src/api/route-inventory.ts`). Regenerate with `yarn api:inventory`; the backend test
`route-inventory.test.ts` (CI: `yarn api:inventory:check` and the full suite) fails when it differs. Do not edit by hand.

Implemented routes only: a route in `docs/architecture/api-design.md` that is not listed here is specified, not available.
Contracts, payloads and error codes are in `api-design.md`; the business routes need `Authorization: Bearer <MRE token>` and
`organizationid: <mreRealmId>` (`mre-integration.md` §47.2).

Routes: 156.

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
| POST | `/api/v1/depreciation-assets` |
| GET | `/api/v1/depreciation-assets/:assetId` |
| POST | `/api/v1/depreciation-assets/:assetId/amend` |
| POST | `/api/v1/depreciation-assets/:assetId/confirm` |
| GET | `/api/v1/depreciation-assets/:assetId/schedule` |
| GET | `/api/v1/depreciation-assets/:assetId/schedule-versions` |
| POST | `/api/v1/depreciation-assets/:assetId/schedule-versions` |
| GET | `/api/v1/depreciation-assets/:assetId/schedule-versions/:versionId` |
| POST | `/api/v1/depreciation-assets/:assetId/void` |
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
| GET | `/api/v1/property-references/:propertyReferenceId/depreciation-assets` |
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
| POST | `/api/v1/rent-reconciliations/:reconciliationId/remove-from-mre` |
| POST | `/api/v1/rent-reconciliations/:reconciliationId/write-back-to-mre` |
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
| POST | `/api/v1/tax-classifications/:classificationId/advisor-confirm` |
| POST | `/api/v1/tax-classifications/:classificationId/confirm` |
| POST | `/api/v1/tax-classifications/:classificationId/mark-needs-review` |
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
| GET | `/api/v1/weg-annual-statements/:statementId/reserve-withdrawals/:position/tax-meaning` |
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
| GET | `/api/v1/weg-special-assessments/:assessmentId/uses/:position/tax-meaning` |
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

### `acquisitions`

- GET `/api/v1/acquisitions`
- POST `/api/v1/acquisitions`
- GET `/api/v1/acquisitions/:acquisitionId`
- GET `/api/v1/acquisitions/:acquisitionId/anschaffungsnahe-herstellungskosten`
- POST `/api/v1/acquisitions/:acquisitionId/cancel`
- POST `/api/v1/acquisitions/:acquisitionId/confirm`
- GET `/api/v1/acquisitions/:acquisitionId/costs`
- POST `/api/v1/acquisitions/:acquisitionId/costs`
- POST `/api/v1/acquisitions/:acquisitionId/costs/:costId/void`
- POST `/api/v1/acquisitions/:acquisitionId/land-building-allocation`
- GET `/api/v1/acquisitions/:acquisitionId/land-building-allocations`
- GET `/api/v1/acquisitions/:acquisitionId/owner-allocation`
- GET `/api/v1/acquisitions/:acquisitionId/payments`
- POST `/api/v1/acquisitions/:acquisitionId/payments`
- POST `/api/v1/acquisitions/:acquisitionId/payments/:paymentId/unlink`

### `depreciation-assets`

- POST `/api/v1/depreciation-assets`
- GET `/api/v1/depreciation-assets/:assetId`
- POST `/api/v1/depreciation-assets/:assetId/amend`
- POST `/api/v1/depreciation-assets/:assetId/confirm`
- GET `/api/v1/depreciation-assets/:assetId/schedule`
- GET `/api/v1/depreciation-assets/:assetId/schedule-versions`
- POST `/api/v1/depreciation-assets/:assetId/schedule-versions`
- GET `/api/v1/depreciation-assets/:assetId/schedule-versions/:versionId`
- POST `/api/v1/depreciation-assets/:assetId/void`

### `financial-accounts`

- GET `/api/v1/financial-accounts`
- POST `/api/v1/financial-accounts`
- GET `/api/v1/financial-accounts/:financialAccountId`
- POST `/api/v1/financial-accounts/:financialAccountId/close`

### `financial-categories`

- GET `/api/v1/financial-categories`
- GET `/api/v1/financial-categories/:code`

### `health`

- GET `/api/v1/health`
- GET `/health/live`
- GET `/health/ready`

### `imports`

- GET `/api/v1/imports/:importBatchId`
- GET `/api/v1/imports/:importBatchId/review-items`
- POST `/api/v1/imports/:importBatchId/review-items/:reviewItemId/resolve`
- POST `/api/v1/imports/bank-transactions`

### `loans`

- GET `/api/v1/loans`
- POST `/api/v1/loans`
- GET `/api/v1/loans/:loanId`
- GET `/api/v1/loans/:loanId/allocations`
- POST `/api/v1/loans/:loanId/allocations`
- POST `/api/v1/loans/:loanId/allocations/:allocationSetId/void`
- POST `/api/v1/loans/:loanId/amend`
- GET `/api/v1/loans/:loanId/balance-statements`
- POST `/api/v1/loans/:loanId/balance-statements`
- POST `/api/v1/loans/:loanId/balance-statements/:statementId/void`
- POST `/api/v1/loans/:loanId/close`
- GET `/api/v1/loans/:loanId/payment-proposal`
- GET `/api/v1/loans/:loanId/payments`
- GET `/api/v1/loans/:loanId/remaining-debt`
- GET `/api/v1/loans/:loanId/schedule`
- GET `/api/v1/loans/:loanId/terms`
- POST `/api/v1/loans/:loanId/terms`
- POST `/api/v1/loans/:loanId/terms/:termsId/void`
- POST `/api/v1/loans/:loanId/void`

### `ownerships`

- POST `/api/v1/ownerships`
- GET `/api/v1/ownerships/:ownershipId`
- POST `/api/v1/ownerships/:ownershipId/close`
- POST `/api/v1/ownerships/:ownershipId/void`

### `parties`

- GET `/api/v1/parties`
- POST `/api/v1/parties`
- GET `/api/v1/parties/:partyId`
- POST `/api/v1/parties/:partyId/amend`
- POST `/api/v1/parties/:partyId/deactivate`
- GET `/api/v1/parties/:partyId/external-references`
- POST `/api/v1/parties/:partyId/external-references`
- POST `/api/v1/parties/:partyId/external-references/:externalReferenceId/end`

### `property-references`

- GET `/api/v1/property-references`
- GET `/api/v1/property-references/:propertyReferenceId`
- GET `/api/v1/property-references/:propertyReferenceId/acquisitions`
- GET `/api/v1/property-references/:propertyReferenceId/depreciation-assets`
- GET `/api/v1/property-references/:propertyReferenceId/loans`
- POST `/api/v1/property-references/:propertyReferenceId/ownership-changes`
- GET `/api/v1/property-references/:propertyReferenceId/ownerships`
- POST `/api/v1/property-references/:propertyReferenceId/refresh`
- GET `/api/v1/property-references/:propertyReferenceId/tax-meanings`
- GET `/api/v1/property-references/:propertyReferenceId/tax-years/:year`
- GET `/api/v1/property-references/:propertyReferenceId/transactions`
- GET `/api/v1/property-references/:propertyReferenceId/weg-memberships`
- POST `/api/v1/property-references/link`

### `rent-reconciliations`

- GET `/api/v1/rent-reconciliations`
- POST `/api/v1/rent-reconciliations`
- GET `/api/v1/rent-reconciliations/:reconciliationId`
- POST `/api/v1/rent-reconciliations/:reconciliationId/confirm`
- POST `/api/v1/rent-reconciliations/:reconciliationId/reject`
- POST `/api/v1/rent-reconciliations/:reconciliationId/release`
- POST `/api/v1/rent-reconciliations/:reconciliationId/remove-from-mre`
- POST `/api/v1/rent-reconciliations/:reconciliationId/write-back-to-mre`
- GET `/api/v1/rent-reconciliations/split-proposal`
- POST `/api/v1/rent-reconciliations/suggest`
- GET `/api/v1/rent-reconciliations/terms/:mreTenantId/:mreRentTerm`

### `rental-contract-references`

- GET `/api/v1/rental-contract-references`
- POST `/api/v1/rental-contract-references`
- GET `/api/v1/rental-contract-references/:rentalContractReferenceId`
- POST `/api/v1/rental-contract-references/:rentalContractReferenceId/amend`

### `security-deposits`

- GET `/api/v1/security-deposits`
- POST `/api/v1/security-deposits`
- GET `/api/v1/security-deposits/:depositId/tax-meaning`
- GET `/api/v1/security-deposits/:securityDepositId`
- POST `/api/v1/security-deposits/:securityDepositId/amend`
- POST `/api/v1/security-deposits/:securityDepositId/close`
- POST `/api/v1/security-deposits/:securityDepositId/reopen`
- POST `/api/v1/security-deposits/:securityDepositId/void`

### `tax-classifications`

- GET `/api/v1/tax-classifications`
- POST `/api/v1/tax-classifications`
- GET `/api/v1/tax-classifications/:classificationId`
- POST `/api/v1/tax-classifications/:classificationId/advisor-confirm`
- POST `/api/v1/tax-classifications/:classificationId/confirm`
- POST `/api/v1/tax-classifications/:classificationId/mark-needs-review`

### `tax-rules`

- GET `/api/v1/tax-rules`
- GET `/api/v1/tax-rules/:ruleCode`

### `transaction-splits`

- GET `/api/v1/transaction-splits/:splitId/tax-meaning`

### `transactions`

- GET `/api/v1/transactions`
- POST `/api/v1/transactions`
- GET `/api/v1/transactions/:transactionId`
- POST `/api/v1/transactions/:transactionId/amend`
- POST `/api/v1/transactions/:transactionId/confirm`
- POST `/api/v1/transactions/:transactionId/correct`
- GET `/api/v1/transactions/:transactionId/hausgeld-proposal`
- POST `/api/v1/transactions/:transactionId/ignore`
- GET `/api/v1/transactions/:transactionId/rent-reconciliations`
- POST `/api/v1/transactions/:transactionId/restore`
- POST `/api/v1/transactions/:transactionId/reverse`
- GET `/api/v1/transactions/:transactionId/settlement-proposal`
- PUT `/api/v1/transactions/:transactionId/splits`

### `weg-annual-statements`

- GET `/api/v1/weg-annual-statements/:statementId`
- PUT `/api/v1/weg-annual-statements/:statementId`
- GET `/api/v1/weg-annual-statements/:statementId/comparison`
- POST `/api/v1/weg-annual-statements/:statementId/confirm`
- GET `/api/v1/weg-annual-statements/:statementId/reserve-withdrawals/:position/tax-meaning`
- POST `/api/v1/weg-annual-statements/:statementId/void`

### `weg-economic-plans`

- GET `/api/v1/weg-economic-plans/:planId`
- POST `/api/v1/weg-economic-plans/:planId/void`

### `weg-memberships`

- GET `/api/v1/weg-memberships/:membershipId`
- POST `/api/v1/weg-memberships/:membershipId/amend`
- GET `/api/v1/weg-memberships/:membershipId/annual-statements`
- POST `/api/v1/weg-memberships/:membershipId/annual-statements`
- GET `/api/v1/weg-memberships/:membershipId/economic-plans`
- POST `/api/v1/weg-memberships/:membershipId/economic-plans`
- POST `/api/v1/weg-memberships/:membershipId/end`
- GET `/api/v1/weg-memberships/:membershipId/special-assessments`
- POST `/api/v1/weg-memberships/:membershipId/special-assessments`
- POST `/api/v1/weg-memberships/:membershipId/void`

### `weg-special-assessments`

- GET `/api/v1/weg-special-assessments/:assessmentId`
- POST `/api/v1/weg-special-assessments/:assessmentId/amend`
- PUT `/api/v1/weg-special-assessments/:assessmentId/uses`
- GET `/api/v1/weg-special-assessments/:assessmentId/uses/:position/tax-meaning`
- POST `/api/v1/weg-special-assessments/:assessmentId/void`

### `wegs`

- GET `/api/v1/wegs`
- POST `/api/v1/wegs`
- GET `/api/v1/wegs/:wegId`
- POST `/api/v1/wegs/:wegId/amend`
- GET `/api/v1/wegs/:wegId/memberships`
- POST `/api/v1/wegs/:wegId/memberships`
- POST `/api/v1/wegs/:wegId/void`
