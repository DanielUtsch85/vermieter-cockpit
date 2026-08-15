# Dashboards

**Project:** Vermieter Cockpit DE
**Version:** 0.1 (first draft)
**Status:** Living Document
**Document Type:** Dashboard Definitions

---

# 1. Purpose & principles

Defines the interactive at-a-glance views. Like reports, dashboards are **derived read models** with no authoritative logic and no independent state (ADR-027).

Principles:
- **Every tile is explainable.** A KPI expands to its formula and inputs (constitution Art. III). Example: not "Cashflow = 184 €" but `Cashflow = Miete − nicht umlagefähige Kosten − Zinsen − Tilgung` (`docs/vision.md`).
- **Actuals and scenarios are visually distinct.** A dashboard may show a scenario overlay, but it must be unmistakably labelled and never mutate actuals (ADR-020, `AGENTS.md` §19).
- **Metrics are derived, not stored as truth.** Where a snapshot is shown, it is an `InvestmentMetricSnapshot` with its calculation metadata (ADR-008, ADR-018-scope).
- **Realm- and ownership-scoped.** Owner-level figures use ownership shares (ADR-011).

The four pillars from `docs/vision.md` — Vermietung, Finanzen, Steuer, Investment — organize the dashboards. No pillar owns its own financial data; all read the same Transactions.

---

# 2. Dashboards (first draft)

## 2.1 Portfolio overview (home)
Top-level answers from `docs/vision.md`:
- total assets (Vermögen), total equity (Eigenkapital) and its trend
- portfolio LTV, total remaining debt
- trailing/'forward liquidity (cashflow)
- upcoming financing resets (Zinsbindung expiries)
- occupancy / rent status (from MRE operational state)

Tiles: Equity · Portfolio value (with clearly-marked valuation source, non-canonical per ADR-021) · LTV · Net cashflow (period) · Remaining debt · Next Zinsbindung expiry.

## 2.2 Property detail
Per-property one-page cockpit:
- acquisition summary (price, costs, land/building split)
- financing (loan, rate, remaining debt, schedule)
- cashflow breakdown (income vs interest/principal/non-recoverable costs)
- NOI and Cash-on-Cash for the property
- AfA status
- WEG status (Hausgeld components, reserve)

## 2.3 Cashflow & liquidity
- monthly/annual cash in vs out, per property and portfolio
- recurring vs one-off
- **cash-only** (excludes AfA/non-cash), consistent with the ledger

## 2.4 Financing
- loans overview, interest vs principal over time
- remaining debt (derived), Zinsbindung timeline
- shared-loan allocation across properties (`LoanAllocation`)
- refinancing scenario overlay (clearly marked scenario)

## 2.5 Tax view
- per tax year: Einnahmen, Werbungskosten, AfA, result — derived from `docs/germany/taxation.md` + `docs/germany/depreciation.md`
- rule version indicator
- **Blocked by** those germany specs; shows "spec pending" until then.

## 2.6 Investment performance
- NOI, cashflow, equity, LTV, Cash-on-Cash, IRR, portfolio performance (metric definitions per `AGENTS.md` §18)
- historical snapshots for comparison (ADR-008)
- scenario comparison (actual vs assumption), strictly separated

---

# 3. KPI catalogue (definitions to finalize)

Each KPI needs one documented, reproducible, **versioned** formula before implementation (constitution Art. III; **ADR-042** investment formula versioning — snapshots pin their formula version). First-draft intents:

| KPI | Intent (to be formalized) |
|---|---|
| NOI | operating income − operating expenses (excl. financing & AfA) |
| Net cashflow | cash in − cash out (incl. interest + principal), cash-only |
| Equity | asset value − remaining debt (value source marked non-canonical) |
| LTV | remaining debt ÷ property value |
| Cash-on-Cash | annual pre-tax cashflow ÷ invested equity |
| IRR | internal rate of return over actual + assumed cashflows (scenario-aware) |
| Remaining debt | derived from loan schedule + actual payments (ADR-016) |

Exact formulas, sign conventions, and rounding are defined with the Investment domain (Phase 9), not here.

---

# 4. Open items

- Confirm the MVP dashboard set (2.1 Portfolio overview + 2.2 Property detail are the likely first two).
- Formalize each KPI formula as a versioned formula module (ADR-042).
- Decide how valuations (non-canonical, ADR-021) are visually flagged so they are never mistaken for cash truth.
- Define the drill-down contract from tile → formula → source Transactions.
