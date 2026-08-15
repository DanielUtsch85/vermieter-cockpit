Constitution

Project: Vermieter Cockpit DE (working title)

Version: 0.1

Status: Living Document

⸻

Preamble

We believe that managing real estate investments should be transparent, reproducible and understandable.

Real estate is more than a rental contract.
It is a long-term financial investment whose success depends on thousands of decisions made over many years.

Software should help people make better decisions—not hide them behind automation or complexity.

This constitution defines the principles that govern every architectural decision, every feature and every line of code within this project.

Whenever technical, product or implementation decisions conflict with this document, this constitution takes precedence.

⸻

Article I — Ownership

The user owns the data.

The project shall always prioritize user ownership over vendor convenience.

Principles

* Self-hosting is a first-class deployment model.
* Data must always remain exportable.
* No proprietary storage formats.
* No artificial lock-in.
* Users must always be able to migrate away from the software.

The software serves the user.
The user never serves the software.

⸻

Article II — Financial Truth

Financial information exists exactly once.

There is only one financial reality.

Cashflow, taxation, accounting, investment analysis and reporting are merely different interpretations of the same underlying transactions.

Principles

* Financial information must never be duplicated.
* Every transaction has exactly one source of truth.
* Reports are derived—not manually maintained.
* Derived values must never become independent state.

Whenever duplicate financial data exists, the architecture is considered incorrect.

⸻

Article III — Transparency

Every number must be explainable.

The system must never produce values that cannot be reconstructed.

Every calculation must be understandable by both developers and users.

Principles

* Every calculation has a documented formula.
* Every report can be reproduced.
* Every value has a traceable origin.
* Hidden business logic is prohibited.
* Silent assumptions are discouraged.

Transparency is more important than convenience.

⸻

Article IV — Architecture

The architecture shall evolve through extension rather than replacement.

Existing open-source software should be reused whenever possible.

New functionality should be implemented as modular extensions.

Principles

* Prefer composition over modification.
* Prefer modularity over coupling.
* Prefer explicit boundaries over implicit dependencies.
* Every module owns its own business domain.
* Cross-domain dependencies should remain minimal.

Architecture should make future changes easier—not harder.

⸻

Article V — Human Decision Making

AI assists.

Humans decide.

Artificial Intelligence is a productivity tool.

It is never the source of financial truth.

Principles

* AI generates suggestions.
* Users approve decisions.
* AI must never silently modify financial records.
* AI must always remain explainable.
* Every AI-generated proposal must be reviewable.

Automation without accountability is unacceptable.

⸻

Article VI — Quality

Correctness is more important than speed.

Long-term maintainability outweighs short-term implementation effort.

Principles

* Correctness before convenience.
* Simplicity before cleverness.
* Readability before optimization.
* Maintainability before speed.
* Explicitness before magic.

Technical debt should never become business logic.

⸻

Article VII — Extensibility

Business rules must remain replaceable.

The architecture must support future legal, financial and geographical extensions.

Principles

* Country-specific rules belong in dedicated modules.
* Business rules should be versioned.
* Regulations must not be hardcoded into the platform core.
* Modules should communicate through stable interfaces.
* Future countries should be possible without redesigning the platform.

The platform should outlive today’s regulations.

⸻

Article VIII — Investment Thinking

Real estate is treated as an investment.

The software shall understand both operational management and financial performance.

Principles

The platform shall provide first-class support for

* financing
* cashflow
* taxation
* equity
* debt
* depreciation
* investment performance
* long-term wealth creation

Operational property management alone is not sufficient.

Investment intelligence is a core capability.

⸻

Article IX — Open Source

Openness is a design principle.

Open source is more than publishing code.

Architecture, assumptions and calculations should be understandable by anyone.

Principles

* Decisions should be documented.
* Architecture should be visible.
* APIs should be documented.
* Data structures should be understandable.
* Calculations should never be hidden.

Knowledge should not depend on individual contributors.

⸻

Article X — Consistency

Consistency is preferred over flexibility.

The software intentionally guides users toward correct financial models.

Not every workflow should be configurable.

Principles

* Similar concepts should behave similarly.
* The same data should never be entered twice.
* Calculated values should remain calculated.
* Invalid states should be impossible whenever feasible.
* Strong opinions are acceptable when they improve correctness.

Consistency creates trust.

⸻

Article XI — Longevity

Build for decades.

Real estate investments often outlive software trends.

The platform should therefore prioritize stability over novelty.

Principles

* Backwards compatibility matters.
* Migration paths should always exist.
* Stable data models are preferred.
* Architecture should survive technological change.
* Documentation is part of the product.

The software should remain useful long after today’s frameworks have changed.

⸻

Decision Rule

Whenever two possible implementations exist, choose the one that best satisfies the articles of this constitution—even if it requires more work today.

Short-term convenience must never compromise long-term integrity.

⸻

Engineering Oath

When contributing to this project, we commit to the following principles:

* We prefer correctness over convenience.
* We prefer transparency over hidden complexity.
* We prefer explicit design over implicit behaviour.
* We prefer maintainability over short-term speed.
* We prefer reproducible calculations over undocumented assumptions.
* We build software that explains financial reality instead of obscuring it.

Every contribution should leave the system easier to understand than before.

⸻

“Good software manages data. Great software builds trust.”