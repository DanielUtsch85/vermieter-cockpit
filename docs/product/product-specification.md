Product Specification

Project: Vermieter Cockpit DE (working title)

Version: 0.1

Status: Living Document

⸻

1. Introduction

Purpose

Vermieter Cockpit DE is a self-hosted open-source platform for private real estate investors.

The platform combines property management, financial management, taxation and investment analysis into a single integrated system.

Instead of treating these areas as independent applications, the platform considers them different perspectives of the same underlying financial reality.

⸻

Scope

The platform supports the complete lifecycle of residential rental properties.

This includes

* acquisition
* financing
* ownership
* rental management
* property maintenance
* taxation
* reporting
* long-term investment analysis

The primary focus is long-term ownership (“Buy & Hold”).

⸻

2. Product Goals

The primary goals are:

Goal 1

Create a single source of truth for all property-related financial information.

⸻

Goal 2

Eliminate duplicate data entry.

⸻

Goal 3

Provide complete transparency over

* cashflow
* financing
* taxation
* equity
* investment performance

⸻

Goal 4

Support German residential real estate investors without coupling German regulations to the platform core.

⸻

Goal 5

Remain maintainable for decades.

⸻

3. Non Goals

The platform is intentionally not designed to become

* a general ERP
* accounting software
* CRM software
* brokerage software
* property listing platform
* hotel management software
* vacation rental platform
* tax filing software
* banking software

The platform may integrate with these systems.

It shall not replace them.

⸻

4. Target Users

Primary users

* private landlords
* Buy & Hold investors
* owners of rental apartments
* owners of small residential portfolios

Secondary users

* tax advisors
* financial advisors
* spouses and co-investors

Potential future users

* family offices
* small real estate companies

⸻

5. Product Principles

Every feature must support one or more core business domains.

Every feature must improve understanding.

Every feature must have a clearly defined owner.

Features without clear ownership should not be implemented.

The platform should favor correctness over feature count.

⸻

6. Product Domains

The product consists of independent but cooperating business domains.

Each domain owns specific responsibilities.

⸻

Domain 1

Property Management

Purpose

Manage operational rental activities.

Responsibilities

* properties
* tenants
* lease definitions
* rent schedules
* communication
* documents

(There is no separate `Unit` entity in the MVP; the rentable object is `Property`. MRE `Lease` denotes reusable rental terms — the `Lease Definition`; the concrete rental relationship is referenced DE-side as `RentalContractReference`. See `glossary.md` and `AGENTS.md` §4/§27.)

Primary Owner

MicroRealEstate

Does NOT own

* taxation
* investment analysis
* financing
* accounting

⸻

Domain 2

Financial Ledger

Purpose

Maintain the financial truth of the platform.

Responsibilities

* transactions
* transaction splits
* bank imports
* payment matching
* receipts
* balances

Owns

Every financial transaction.

Does NOT own

Tax interpretation.

Investment metrics.

Reports.

These are derived.

⸻

Domain 3

Financing

Purpose

Represent debt over time.

Responsibilities

* loans
* repayment schedules
* interest
* principal
* remaining debt
* refinancing

Outputs

Cashflow

Debt

Interest

Repayment

Forecasts

⸻

Domain 4

WEG

Purpose

Represent German condominium ownership.

Responsibilities

* property management companies
* economic plans
* annual statements
* maintenance reserve
* special assessments
* ownership shares

This module contains German condominium logic only.

⸻

Domain 5

Taxation

Purpose

Represent the tax interpretation of financial events.

Responsibilities

* depreciation
* acquisition costs
* deductible expenses
* tax classifications
* reporting

Important

The module does not create transactions.

It interprets existing ones.

⸻

Domain 6

Investment

Purpose

Evaluate financial performance.

Responsibilities

* equity
* ROI
* NOI
* IRR
* Cash-on-Cash Return
* portfolio value
* market value
* scenarios

Important

Investment metrics are calculated.

They are never stored as independent business data.

⸻

Domain 7

Reporting

Purpose

Present information.

Responsibilities

* dashboards
* exports
* PDFs
* CSV
* annual summaries
* tax packages

Reports never own business logic.

⸻

Domain 8

Automation

Purpose

Reduce repetitive work.

Examples

* recurring transactions
* document generation
* reminders
* workflow automation

Automation must remain deterministic.

⸻

Domain 9

AI Assistant

Purpose

Assist users.

Capabilities

* transaction suggestions
* receipt categorization
* document summarization
* financial explanations
* investment insights

Limitations

AI never modifies financial truth automatically.

⸻

7. Core Workflows

The platform supports several primary workflows.

⸻

Property Acquisition

Property

↓

Purchase

↓

Financing

↓

Acquisition Costs

↓

WEG

↓

Rental

↓

Investment

⸻

Monthly Operations

Rent received

↓

Bank import

↓

Transaction matching

↓

Loan payment

↓

Cashflow

↓

Dashboard

⸻

Annual Closing

Transactions

↓

Tax Interpretation

↓

WEG Statement

↓

Depreciation

↓

Reports

↓

Tax Package

⸻

Investment Analysis

Cashflow

↓

NOI

↓

Debt

↓

Equity

↓

Performance Metrics

↓

Scenario Analysis

⸻

8. Data Ownership

Each business concept has exactly one owner.

Domain	Owns
Property Management	Properties, Tenants, Lease Definitions
Financial Ledger	Transactions
Financing	Loans
WEG	Condominium Data
Taxation	Tax Classification
Investment	Calculated Metrics
Reporting	Presentations
AI	Suggestions

Ownership implies responsibility.

Ownership does not imply duplication.

⸻

9. Product Boundaries

The platform intentionally separates

Operational Management

↓

Financial Ledger

↓

Tax Interpretation

↓

Investment Analysis

↓

Presentation

Every layer depends on the previous one.

No layer modifies a lower layer.

⸻

10. MVP Definition

Version 1.0 is considered complete when a private landlord can operate one rental apartment entirely inside the platform.

Minimum capabilities

✓ Property

✓ Tenant

✓ Lease Definition

✓ Transactions

✓ Loan

✓ WEG

✓ Acquisition Costs

✓ Depreciation

✓ Tax Classification

✓ Cashflow

✓ Dashboard

✓ Annual Tax Export

Everything else is considered future work.

⸻

11. Product Roadmap

The product evolves through maturity stages.

Stage 1

Foundation

Stage 2

Financial Core

Stage 3

German Investment Layer

Stage 4

Portfolio Management

Stage 5

Automation

Stage 6

Artificial Intelligence

Each stage builds on the previous one.

⸻

12. Success Criteria

The project succeeds when a private investor can answer questions such as

* How much equity do I currently own?
* What is my real monthly cashflow?
* How much interest did I pay this year?
* What is my current remaining debt?
* Which investment created the highest return?
* Which expenses are tax relevant?
* What happens if interest rates increase?
* What is the long-term performance of my portfolio?

without exporting data into spreadsheets.

⸻

13. Future Extensions

Potential future domains include

* Open Banking
* OCR
* Document Management
* Portfolio Benchmarking
* Market Data
* Insurance
* Maintenance Planning
* Contractor Management
* Tenant Portal
* Mobile Applications

Future extensions must never violate the Constitution.

⸻

Closing Statement

The objective of Vermieter Cockpit DE is not to replace existing property management software.

Its objective is to become the financial operating system for long-term residential real estate investors.

Every feature should improve understanding.

Every calculation should increase trust.

Every release should move the platform closer to becoming the single source of truth for real estate investments.