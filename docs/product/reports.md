# Reports

**Project:** Vermieter Cockpit DE
**Version:** 0.1 (first draft)
**Status:** Living Document
**Document Type:** Reporting Requirements

---

# 1. Purpose & principles

Defines the reports the product produces. Reports are **read models**: they contain **no authoritative business logic** and hold **no independent state** (ADR-027, constitution Art. II/III).

Governing rules:
- **Derived only.** Every reported figure is computed from canonical data (ledger Transactions/Splits, ownership, acquisition, loans, WEG statements, tax classification, AfA). Reports never become a source of truth.
- **Explainable.** Every number can be expanded to its inputs (constitution Art. III). A report cell links back to the Transactions/rules that produced it.
- **Reproducible.** Re-running a report over unchanged data yields the same result. Where a report depends on versioned rules (tax/AfA), it records which rule version was applied.
- **Provenance-preserving.** Imported/derived figures remain traceable to source (`AGENTS.md` §22).
- **Not a filing tool.** Reports support preparation and analysis. This is **not** ELSTER submission and **not** tax advice (constitution; `AGENTS.md` §30).

Every report is scoped by **Realm** and by a **period** and/or **tax year**, and respects owner-level allocation via ownership shares (ADR-011).

---

# 2. Report catalogue (first draft)

## 2.1 Cashflow report
- **Question:** how much cash actually moved, and where?
- **Source:** confirmed ledger Transactions + Splits over a period.
- **Content:** inflows (rent, deposits received, other) vs outflows (interest, principal, non-recoverable operating costs, Hausgeld, maintenance), net cash, per property and portfolio.
- **Note:** cash-only; excludes AfA and other non-cash concepts.

## 2.2 Tax-year overview (Einkünfte aus Vermietung und Verpachtung)
- **Question:** what is the taxable rental result per property and tax year?
- **Source:** classified cash (Werbungskosten) + AfA (derived) + rent income, per `docs/germany/taxation.md`.
- **Content:** Einnahmen, Werbungskosten by category, AfA, result (Überschuss/Verlust). Structured to *support* filling German rental-income forms, without being an official form.
- **Rule version:** records the tax RuleSet version applied.
- **Blocked by:** `docs/germany/taxation.md`, `docs/germany/depreciation.md`.

## 2.3 AfA schedule report
- **Question:** what depreciation applies, from which basis, for how long?
- **Source:** acquisition + land/building allocation → derived AfA schedule (`docs/germany/depreciation.md`).
- **Content:** depreciation basis (building share only), method/rate + statutory basis, annual AfA, remaining book value, schedule end.

## 2.4 Loan / financing report
- **Question:** what do I owe, at what cost, and when does it reset?
- **Source:** loans, planned schedules, actual payments, `LoanAllocation`.
- **Content:** remaining debt (derived), interest vs principal over period, fixed-rate expiry (Zinsbindung), per-property allocation. Planned vs actual shown side by side, never merged (ADR-015).

## 2.5 WEG report
- **Question:** what did the WEG plan, spend, and reserve?
- **Source:** Wirtschaftsplan, Jahresabrechnung, cost lines, Erhaltungsrücklage, Sonderumlagen (`docs/germany/weg.md`).
- **Content:** Hausgeld components (recoverable vs non-recoverable vs reserve), reserve development, special assessments, with preserved statement structure.

## 2.6 Portfolio summary
- **Question:** how is the whole portfolio doing?
- **Source:** aggregation of the above + investment metrics.
- **Content:** equity, LTV, NOI, cashflow, Cash-on-Cash, per-property comparison. Metrics link to `docs/product/dashboards.md`; snapshots per ADR-008.

## 2.7 Security deposit report
- **Source:** Security Deposit domain (ADR-013).
- **Content:** expected vs received vs repaid per rental relationship; never shown as rental income.

---

# 3. Export

Per constitution Art. I and ADR-030, reports are exportable in open formats (e.g. CSV/PDF/JSON). Exports carry enough metadata (period, Realm, rule versions, generation timestamp) to be reproducible and auditable.

---

# 4. Explicit non-goals

- No ELSTER/official e-filing.
- No automated tax optimization or advice.
- No editable report figures that feed back into canonical data.
- No report that computes a rule the domain layer does not own.

---

# 5. Open items

- Confirm the exact set of MVP reports (2.1, 2.2, 2.4 are the likely first three — cashflow, tax-year, loan).
- Define the drill-down contract (report cell → source Transactions/rules).
- Decide export formats and templating once reporting is implemented (Phase 9).
- Align tax-year report layout with the current German rental-income form structure **after** `germany/taxation.md` is drafted (VERIFY against the applicable form for the year).
