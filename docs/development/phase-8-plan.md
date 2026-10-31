# Phase 8 Plan — Depreciation (AfA)

**Status:** Accepted (#173). The project owner's decisions of 2026-10-30 are recorded in §1 (**Decided** lines). VC-8-01 is implemented (api-design §59, migration 0049); VC-8-02 is implemented (api-design §59A, no migration; `DE_AFA_BUILDING_LINEAR` renumbered, `@1` for 2006–2022 and `@2` from 2023); VC-8-03 and VC-8-04 are specified (api-design §59B, §60); VC-8-05 is specified in #181 (api-design §58C, "VC-8-05: the AfA in the view"); VC-8-06 is next. The rates before 2023 and the disposal year were decided on 2026-10-31 (api-design §59A); the tax advisor's confirmation of `DE_AFA_BUILDING_LINEAR@1` and of the disposal year is still open (their figures are provisional). The rest of the implementation waits on the project owner's answers: the start and end of later costs, and the freeze gate (§60 open question 5).
**Roadmap:** `docs/roadmap.md` Phase 8 · **Backlog:** `backlog.md` §3g (VC-8-xx)

Phase 8 is modelled conceptually in several places:
- AGENTS.md §17 (depreciation is derived, never cash), ADR-010 (the Acquisition carries the depreciation basis), ADR-022 and ADR-041 (rules are versioned code modules);
- `docs/germany/depreciation.md`, verified on 29.10.2026 (v0.2; `verification-checklist.md` B1–B11), with `taxation.md` §6 and §6.2 (A2, A3, A6, E2);
- data-model §15 (`LandBuildingAllocation`), §38 (`DepreciationAsset`), §39 (`DepreciationScheduleVersion`), §40 (`DepreciationScheduleEntry`); domain-model §14, §48–§51;
- api-design §59 and §60 (placeholders: `depreciation-assets`, `recalculate`, `correct-basis`), and §58C's AfA block, which Phase 7 left empty.

Several points are open, or would not fit what Phases 2 and 7 built:
- **What is stored.** Data-model §38 stores `basisAmount` on a `DepreciationAsset`, and §39–§40 store schedule versions with their entries. AGENTS.md §17 and data-model §82 call the annual amount derived. The roadmap's exit says "stored as derivation". Domain-model §51 leaves the persistence strategy open.
- **The rate needs a fact DE does not have.** § 7 Abs. 4 EStG selects the rate by the building's completion (depreciation.md §3). No entity records it.
- **The basis.** Phase 2 records the price, the costs and the land/building allocation (P2-D7, P2-D9); §58B already derives the building's acquisition cost for the 15 % check. Phase 7 lists `CAPITALIZED` items in the view's `capitalized`, "for the AfA basis of Phase 8" (§58C). How they enter the basis, and from when, is not specified.
- **The owners.** §27.4 (P2-D10) splits an Acquisition among its own buyers; §58C splits each cash item by the shares on its date. The AfA has to fit both.
- **The year.** § 7 Abs. 1 S. 4 EStG prorates the first year by month (B6). The year of a sale, and later costs, are not covered by `depreciation.md`.
- **The view.** §58C's `depreciation` block is `DEPRECIATION_NOT_AVAILABLE`, the result `BEFORE_DEPRECIATION`, and `final` is always false. Phase 8 is the first phase in which a year can become final.

This plan fixes those points **before** the items are specified, as `phase-7-plan.md` did for Phase 7. Each item's spec PR then only has to write out the contract.

**Exit (roadmap Phase 8):** an AfA schedule is reproducible from acquisition truth, stored as derivation (not cash), and feeds the tax-year view.

With it, the exit of Phase 7 is complete (P7-D8): the tax-year view's AfA block carries a figure, the Werbungskosten include it, and `result.basis` moves from `BEFORE_DEPRECIATION` to `AFTER_DEPRECIATION`. ACC8 proves it.

---

# 0. Input from the earlier phases

- **Phase 2 records the acquisition truth** (P2-D6–P2-D10):
  - the `Acquisition` with `purchasePrice`, `acquiredShare`, `contractDate` and `economicTransferDate` (Übergang von Nutzen und Lasten); the transfer date is `economicTransferDate`, else `contractDate` (P2-D6);
  - its `AcquisitionCost`s by category, with `FINANCING_RELATED` among them (A6: not acquisition cost);
  - the current `LandBuildingAllocation` with `method` (`PURCHASE_CONTRACT`, `BMF_TOOL`, `APPRAISAL`, `ADVISOR`, `OTHER`) and `reviewState`; recorded as entered, never computed;
  - the Ownerships carrying the Acquisition's id, and §27.4's split among the buyers (weights `share / acquiredShare`, largest remainder). §27.4 states that only a `CONFIRMED` Acquisition feeds Phases 7 and 8.
- **Phase 7 derives the building's acquisition cost** for the anschaffungsnahe check (§58B, `domains/taxation/anschaffungsnahe.ts`): (price + `ACTIVE` costs without `FINANCING_RELATED`) × `buildingAmount` / `totalAllocableAmount` of the current `CONFIRMED` or `ADVISOR_CONFIRMED` allocation, rounded once to the cent; otherwise `NOT_COMPUTABLE` with the reason. That is the starting point of the AfA basis (B5).
- **Phase 7 lists what this year adds to the basis:** the view's `capitalized` (§58C), the items whose treatment is `CAPITALIZED` (splits, reserve withdrawals, Sonderumlage uses), a refund of Herstellungskosten negative. A capitalisation that follows the check names its Acquisition (`anschaffungsnaheAcquisitionId`, §58B).
- **Phase 7 provides the mechanics:** the rule registry (`domains/taxation/rules/`, `GET /tax-rules`, the start check of stored `ruleCode@version`), `largestRemainder` (`domains/acquisition/owner-allocation.ts`), the tenure of an owner (`continuousOwners()`, `distribution-82b.ts`), the view's snapshot and review table.
- **What is missing:** the building's completion year, any record of a depreciable asset, a schedule, and an AfA line in the view.

---

# 1. Decisions

Each decision names whether it **needs the user** (a choice only the project owner, with the tax advisor where marked VERIFY, can make) or is **for review** (the plan's proposal stands unless the review objects).

### P8-D1 The building is a `DepreciationAsset`; it stores its own inputs, never its basis (amends data-model §38)

- **Options:**
  1. the completion year on the `Acquisition`;
  2. the completion year on the `PropertyReference`;
  3. a `DepreciationAsset` (data-model §38) per PropertyReference for the building, with its own inputs.
- **Recommendation: 3.** The completion year is a fact of the building, not of a purchase: two Acquisitions of shares of one unit share it. The PropertyReference is MRE's anchor and carries no DE facts (AGENTS.md §4, §11). A `DepreciationAsset` is the aggregate the model already names (domain-model §48–§49).
- **Stored on the asset** (the canonical interpretive inputs):
  - `assetType` `BUILDING` (one per PropertyReference, a partial unique index); `SEPARATE_ASSET` with VC-8-03 (P8-D7 decided option 1);
  - `buildingCompletionYear`, with `sourceReferences` (e.g. the Teilungserklärung, the energy certificate);
  - `depreciationMethod` `LINEAR_7_4` (the only one, P8-D13);
  - the optional shorter useful life of P8-D4, with its evidence;
  - `reviewState` (`UNREVIEWED`, `NEEDS_REVIEW`, `CONFIRMED`, `ADVISOR_CONFIRMED`, as the allocation's, data-model §6.7), `advisorPartyId`, `notes`.
- **Derived, never stored:** the basis, the rate, the start, every year's amount (AGENTS.md §17, data-model §82). Data-model §38's `basisAmount`, `startDate`, `depreciationRate` and `landBuildingAllocationId` become derived fields of the read; `acquisitionId` gives way to the components of P8-D2.
- **Changes** are commands with `If-Match` (amend, confirm, void); content is never edited silently, and every change writes an AuditRecord. A correction of the completion year changes the derived schedule of every year; P8-D10 makes that visible.
- **Needs the user:** no (for review).
- Docs: data-model §38 rewritten, domain-model §49, glossary (`DepreciationAsset` if absent).

### P8-D2 The AfA basis (B5, B11, A2, A6; taxation.md §6)

- **Components of the building's basis**, each traceable to its source:
  1. **per `CONFIRMED` Acquisition** of the PropertyReference: the building's acquisition cost exactly as §58B derives it (price + `ACTIVE` costs without `FINANCING_RELATED`, × building / total of the current confirmed allocation, rounded once). **One function** serves the 15 % threshold and the AfA basis, moved out of `anschaffungsnahe.ts` into the Acquisition or Depreciation domain; a test asserts both read the same amount. Land never enters (B5, depreciation.md §1).
  2. **each `CAPITALIZED` item** of the PropertyReference (§58C `capitalized`, every year up to the year computed): its `lineAmount`, a refund negative. This includes the anschaffungsnahe Herstellungskosten the user capitalised on the check (A2, B11: "fließen in die AfA statt in den Sofortabzug").
- **Only a classification moves the basis.** A source the check flags `ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN` with a *suggested* `CAPITALIZED` stays where its treatment puts it, as §58C and §58B decided ("DE changes nothing on its own"). The open flag keeps the year from being final until the user decides.
- **Never twice:** an item in `capitalized` is in no Werbungskosten line (§58C), and the basis reads exactly that list. A test compares the basis components of a year with the `capitalized` items of all years up to it.
- **Costs at their expected amount**, as §27.4 and §58B: the acquisition's economics, not its cash. A cost not yet paid is informative (`ACQUISITION_COST_UNPAID`), not a reduction.
- **Not computable** (`DEPRECIATION_NOT_AVAILABLE` for that component, with the reason; never estimated): no `CONFIRMED` Acquisition, no allocation, an unconfirmed allocation (data-model §15: "only confirmed allocation should feed canonical depreciation calculations"), no asset or no completion year, no applicable rule (P8-D4).
- **VERIFY:**
  - that non-deductible VAT of a private landlord is part of the Herstellungskosten, so the gross `lineAmount` enters the basis (§ 9b Abs. 1 EStG; not covered by `depreciation.md`). Phase 7 uses net amounts only for the 15 % threshold (A2), never for the basis;
  - that a cost of category `OTHER` is acquisition cost: §58B already counts it in the threshold; the user records it, DE does not judge it.
- **Needs the user:** no for the composition (for review); yes for the two VERIFY points (tax advisor).
- **Reviewer input on #173** (a note for the tax advisor, not final law): by § 9b Abs. 1 EStG, input VAT that cannot be deducted belongs to the acquisition or production cost. For a private landlord without a VAT option the gross amount is therefore the basis. The only open case is a landlord who opted under § 9 UStG (then net), which P8-D13 places out of scope.

### P8-D3 The land/building split stays the user's input (A3, E2; taxation.md §6.2)

- **Options:**
  1. as Phase 2: the allocation is entered with its `method` and sources, and only a confirmed one feeds the AfA;
  2. DE computes the split by the BMF-Arbeitshilfe (Stand März 2026);
  3. option 1, plus a plausibility check against the BMF-Arbeitshilfe.
- **Recommendation: 1.** The Arbeitshilfe is a typified procedure that changes with each edition (A3); computing it would be a rule set of its own with land values and building data DE does not hold (E2). A contractual split is "gesondert zu würdigen" (A3): DE records it, the user (or the advisor) confirms it. Options 2 and 3 can follow as an item of their own.
- **A superseding allocation** (P2-D9) changes the basis of every year from the start; P8-D10 makes that visible.
- **Needs the user:** yes, to confirm that option 1 is enough (option 3 is the alternative). **VERIFY:** none beyond A3 and E2; whether a given contractual split holds is case-dependent and stays the user's.
- **Decided (2026-10-30):** option 1 (the allocation as entered, no BMF-Arbeitshilfe), taken as recommended. The user can still change it in review.

### P8-D4 The rate by the completion year; a shorter useful life (B1–B3, B7; depreciation.md §3)

- **The rate** of linear building AfA in private assets (§ 7 Abs. 4 S. 1 Nr. 2 EStG):
  - completed **after 31.12.2022:** 3 % (Buchst. a, B1);
  - completed **before 01.01.2023 and after 31.12.1924:** 2 % (Buchst. b, B2);
  - completed **before 01.01.1925:** 2.5 % (Buchst. c, B3).
- **The year is enough.** Both boundaries are year-ends, so `buildingCompletionYear` decides the band without a date: ≥ 2023 → 3 %, 1925–2022 → 2 %, ≤ 1924 → 2.5 %. The band boundaries are rule parameters, never constants (AGENTS.md §16).
- **The rule:** `DE_AFA_BUILDING_LINEAR@1` (P8-D11), with the bands, the first-year rule of P8-D5 and the end of P8-D9. Selected by the **tax year computed**. Version 1 is effective from 2023-01-01, the first year the 3 % band applies. **Renumbered (decided 2026-10-31, api-design §59A "The rule versions"; done with VC-8-02):** today's rule is `@2` (from 2023) and `@1` covers 2006–2022 with the lettering then in force (read on 31.10.2026, `verified` false until the tax advisor confirms it).
- **Years before 2023** (the view accepts years from 2000): **decided 2026-10-31** (api-design §59A): years 2006–2022 by an earlier version with the lettering then in force, flagged `HISTORICAL_RULE_TO_VERIFY` until the tax advisor confirms it; a contract or start before 2006 not computable (`HISTORICAL_RULE_NOT_SUPPORTED`); the band always by the completion year, never by the purchase date.
- **A shorter actual useful life** (§ 7 Abs. 4 S. 2 EStG, B7; depreciation.md §9 asks Phase 8 to fix its fields):
  - **Options:** (a) supported: an optional `usefulLifeYears` per Acquisition component, with `evidence` (source, date, document reference) and its own `reviewState`; the rate is then 1 / `usefulLifeYears`, flagged `SHORTER_USEFUL_LIFE` (informative once confirmed); (b) out of scope, refused.
  - **Recommendation:** (a), since `depreciation.md` §9 asks for the fields. The repealed BMF requirements of 2023 are **not** encoded as checks (B7): DE records the evidence and judges nothing.
- **VERIFY:** that bands b and c applied unchanged in the earlier years the app may compute (before 2023); whether a shorter useful life, once claimed, applies from the start or from the year it is evidenced (not covered by `depreciation.md`).
- **Needs the user:** yes for the shorter useful life (in or out); no for the bands (verified, B1–B3).
- **Decided (2026-10-30):** the shorter actual useful life is **in Phase 8**, option (a): an optional `usefulLifeYears` with its evidence and its own `reviewState`. DE records it and judges nothing (B7). VC-8-01 specifies the fields (api-design §59: one entry per Acquisition on the asset; only a confirmed entry feeds a figure). **Shorter** means fewer years than the fixed threshold § 7 Abs. 4 S. 2 EStG names for the band: 33 (Buchst. a), 50 (Buchst. b), 40 (Buchst. c), a rule parameter `shorterThanYears` per band, never derived from the rate (review on #174; depreciation.md §3, B7). **Verified (30.10.2026):** the thresholds match the official text of § 7 Abs. 4 S. 2 EStG (gesetze-im-internet.de), read before VC-8-01 was implemented.

### P8-D5 The start and the first year (B6; depreciation.md §5)

- **The start** of a component of P8-D2 (1) is its Acquisition's **transfer date** (P2-D6): the Übergang des wirtschaftlichen Eigentums, regularly Nutzen und Lasten (B6). A newly built building's completion is out of scope (P8-D13).
- **No `economicTransferDate`:** the `contractDate` serves, flagged `TRANSFER_DATE_ASSUMED` (open). The assumption is never silent. This answers `depreciation.md` §9's second open point: the field exists (P2-D6).
- **The first year** (§ 7 Abs. 1 S. 4 EStG, B6): the annual amount less 1/12 for each **full** month before the transfer month; the transfer month counts in full. A transfer in April gives 9/12 (depreciation.md §5), one on 31 December gives 1/12, one on 1 January 12/12 of that year and nothing of the year before.
- **The tax year of AfA is the calendar year of the months it covers.** § 11 EStG and the 10-day rule do not apply (AfA is no Abfluss); a capitalised item keeps its own date (P8-D6), not its tax year by §58A.
- **Needs the user:** no (verified, B6).

### P8-D6 Later Herstellungskosten and anschaffungsnahe Herstellungskosten (B11, A2)

- **They raise the basis** of the building and are depreciated **by the building's method and rate**, not by a mode of their own (B11: no "Restwert-AfA"). The annual amount is the rate × the basis at that time; the AfA runs until the whole basis is depreciated (P8-D9). A refund of Herstellungskosten lowers the basis (§58C's sign).
- **From when** a capitalised item counts is not covered by `depreciation.md`. **Options:**
  1. **from the start of the year** of the item's date;
  2. **from the month** of the item's date, prorated as P8-D5;
  3. **anschaffungsnahe items from the transfer date**, as if part of the purchase; other items as 1 or 2.
- **Recommendation:** decide with the tax advisor before VC-8-03 is specified. The choice is a parameter of `DE_AFA_BUILDING_LINEAR` (`subsequentCostStart`), so it is one line in the rule and ACC8 asserts whichever is chosen. The plan does not pick one: AGENTS.md §30.
- **The date of a capitalised item** is the item's date as Phase 7 has it (booking date, withdrawal or use date). Where the work was carried out earlier, the booking date may differ (§58B's `DATE_IS_BOOKING_DATE`); the item then carries that flag into the schedule.
- **Retroactive effect:** when the check crosses 15 % in the third year and the user capitalises earlier sources, the AfA of every year from the first source changes, and those years' Werbungskosten fall by the same sources. DE derives both, flags `DEPRECIATION_CHANGED_SINCE_RECORDED` where a recorded version differs (P8-D10), and changes nothing on its own (as P7-D6: "a filed year may be affected").
- **VERIFY:** the start of a later cost (the options above); whether an anschaffungsnahe item counts from the transfer date or from its own date.
- **Needs the user:** yes (with the tax advisor).
- **Reviewer input on #173** (a note for the tax advisor, not final law): R 7.4 Abs. 9 S. 3 EStR treats later Herstellungskosten as incurred at the **start of the year** in which they arise. That is option 1, `subsequentCostStart` = `START_OF_YEAR`, with no special case for anschaffungsnahe costs. Option 3 has no basis. To be confirmed with the tax advisor before VC-8-03 is specified.
- **Specified (VC-8-03, api-design §59B), as a proposal, not decided:** `subsequentCostStart` `START_OF_YEAR` (option 1, the reviewer's reading), never before the owner's start (an item in the year of the purchase starts with the purchase), computed with the open flag `SUBSEQUENT_COST_START_TO_VERIFY` on the item's first and last year until the tax advisor confirms it (§59B open question 1); `MONTH_OF_DATE` (option 2) is implemented as the alternative value, option 3 is not. Only a `CAPITALIZED` classification moves the basis, never the check's suggestion. Items run at the owner's purchase rate; how they continue after the purchase is exhausted, and with a shorter useful life, is a new VERIFY point (`SUBSEQUENT_COST_END_TO_VERIFY`, `SUBSEQUENT_COST_SHORTER_LIFE_TO_VERIFY`; §59B open question 2). **Proposed (review on #179, not decided):** one pooled basis per owner, the rate × the whole basis until the whole residual value is zero (R 7.4 Abs. 9 S. 1 EStR, quoted from memory, VERIFY), with the remaining useful life of S. 2 as an option not yet computed; until the purchase is exhausted it gives the same figures as a series per item, and `SUBSEQUENT_COST_END_TO_VERIFY` marks the years after, where the two differ. **Decided 2026-10-31** (owner: provisional): the proposal stands, flagged `SUBSEQUENT_COST_START_TO_VERIFY` / `SUBSEQUENT_COST_END_TO_VERIFY` until the tax advisor confirms; separate assets before 2023 stay not computable (api-design §59B).

### P8-D7 Separate movable assets: the Einbauküche (B8, B9)

- **The risk without a decision:** every `CAPITALIZED` item goes into the building's basis. A complete Einbauküche is a separate asset over 10 years (BFH IX R 14/15, B8), not 2 % of the building. Placed in the building, it would be depreciated over 50 years without a warning.
- **Options:**
  1. a `DepreciationAsset` of type `SEPARATE_ASSET`: the user names its capitalised items and `usefulLifeYears` (10 for a kitchen, B8; others by their useful life, § 7 Abs. 1 EStG), linear with the month rule of § 7 Abs. 1 S. 4 (P8-D5). The items it names leave the building's basis; an item belongs to at most one asset (a unique index);
  2. out of scope: the user may mark a capitalised item as not part of the building; it then leaves the basis, flagged `SEPARATE_ASSET_NOT_DEPRECIATED` (open);
  3. nothing: every capitalised item stays in the building.
- **Recommendation: 1**, with a rule `DE_AFA_MOVABLE_LINEAR@1`. It reuses the whole machinery and is small. Option 3 is not acceptable (a known error without a flag).
- **GWG** (B9): a movable asset up to 800 € net is deducted at once; it is Phase 7's `DEDUCTIBLE`, nothing to do here. The Sammelposten of § 6 Abs. 2a is not modelled (B9).
- **Needs the user:** yes (1 or 2).
- **Decided (2026-10-30):** option 1. Separate assets (e.g. the Einbauküche over 10 years) are **in Phase 8** as `SEPARATE_ASSET`, with their own rule `DE_AFA_MOVABLE_LINEAR@1` (VC-8-03, api-design §59B).
- **Specified (VC-8-03, api-design §59B):** the asset stores `description`, `usefulLifeYears` with its basis, `acquiredOn` and the links to its capitalised items (migration 0051, `depreciation_asset_item`, one `ACTIVE` asset per item by a partial unique index); its cost is derived from those items, its start is the month of `acquiredOn` (§ 7 Abs. 1 S. 4 EStG); an anschaffungsnahe item cannot be linked; GWG only as the informative hint `GWG_THRESHOLD_MAY_APPLY`.

### P8-D8 Owners: each Acquisition's AfA belongs to its buyers (P2-D10, P7-D7, data-model §12.5)

- **Options:**
  1. **per component:** an Acquisition's component goes to its own buyers by §27.4's weights (`share / acquiredShare`), for the months their tenure lasts; a capitalised item goes to the owners on its date, by the shares then (P7-D7), and depreciates in each owner's part;
  2. **per property:** the property's AfA of a month × the shares of that month, as §58C does for a cash item.
- **Recommendation: 1.** Each owner depreciates their own acquisition cost. With option 2, a buyer of a share at a higher price would depreciate the seller's basis. With one Acquisition of the whole and no change, both give the same figures.
- **The tenure** is §58C's: the continuous run of `VALID` Ownerships of the Party on this PropertyReference. A share changed by §26.2 without a sale does not end it.
- **A share reduced within a tenure** (a buyer sells part): the buyer keeps the fraction of the bought share still held, flagged `OWNER_SHARE_CHANGED` (informative). A share **raised** without an Acquisition, and an owner without any (inheritance, gift), is flagged `OWNER_WITHOUT_ACQUISITION` (open): the continuation of the predecessor's AfA by a successor (§ 11d EStDV) is not covered by `depreciation.md` and stays out (P8-D13).
- **Exact first, then one rounding per owner and year:** each owner's amount of a year is computed exactly (fractions, no floating point), then rounded by **cumulative rounding**: the year's amount is the rounded cumulative AfA to the end of the year minus the rounded cumulative AfA to the end of the year before. So a component's years sum to its basis exactly, and no year drifts.
- **Summed, never distributed** (§27.4's F4b, P7-D7): the property's AfA is the sum of the owners' amounts and the `NOT_OWNED` part (a capitalised item's part of an unowned share), so **owners + `NOT_OWNED` = the property** to the cent, as in §58C.
- **Needs the user:** yes (1 or 2). **VERIFY:** that a co-owner's AfA follows their own acquisition cost (not covered by `depreciation.md`).
- **Decided (2026-10-30):** option 1. Each purchase's AfA goes to that purchase's own buyers while they hold the share, exact to the cent (exact fractions, cumulative rounding). An inheritance or gift is flagged (`OWNER_WITHOUT_ACQUISITION`), not computed.

### P8-D9 The end: the basis exhausted, the tenure ended

- **The basis exhausted:** the AfA stops when the cumulative AfA reaches the basis; the last year takes the remainder (depreciation.md §7: "bis Restbuchwert 0"). With later costs, the period lengthens (B11). The Restbuchwert is derived and shown, never stored.
- **The tenure ended** (a sale, the end of an Ownership): the AfA of the seller's component ends with their tenure. Whether the month of the end counts, and how the year of disposal is prorated, is **not** covered by `depreciation.md`.
  - **Options:** (a) the months up to and including the month of the last day held (`validUntil`); (b) the full months before the month of the transfer to the buyer; (c) the whole year.
  - **Recommendation:** decide with the tax advisor before VC-8-02 is specified; a rule parameter (`endMonthCounts`). Until then a year with an ended tenure is flagged `DISPOSAL_YEAR_TO_VERIFY`, never computed on a guess. ACC8 asserts the chosen option once decided.
- **The end of letting** without a sale (own use) is out of scope (P8-D13): DE does not know a unit's use.
- **Needs the user:** yes for the disposal year (with the tax advisor).
- **Reviewer input on #173** (a note for the tax advisor, not final law): the year of a sale is prorated (R 7.4 Abs. 8 EStR), and the month of the sale counts (to be confirmed). The cut-off is the transfer of economic ownership: the buyer's Acquisition's `economicTransferDate` if there is one, otherwise the seller's `validUntil`, flagged in the same way as `TRANSFER_DATE_ASSUMED`. To be confirmed with the tax advisor before VC-8-02 is specified.

### P8-D10 Derived on read; recorded as versions (resolves data-model §39–§40, domain-model §51, api-design §60)

- **Options:**
  1. **derived only:** the schedule is computed on every read, like the tax-year view (P7-D8); nothing is stored;
  2. **stored:** a `recalculate` command (api-design §60) writes a `DepreciationScheduleVersion` with entries, and the view reads the current version;
  3. **derived, and recorded on request:** the schedule is computed on every read (the truth); a command records a version (data-model §39–§40) with its entries, its input components and the rule versions; the view compares the derived schedule with the latest recorded version.
- **Recommendation: 3.**
  - Option 1 does not meet the roadmap's "stored as derivation", and it shows no history: a confirmed allocation superseded, or a source capitalised in year 3, changes earlier years without a trace.
  - Option 2 makes a stale store the figure of the view: a classification changed after the last recalculation would not reach the result.
  - Option 3 keeps the view live, and the recorded versions show what changed and when (domain-model §51).
- **A recorded version** stores, as rows (AGENTS.md §28: no blob):
  - the entries per year, per owner and `NOT_OWNED`;
  - the input components (Acquisition, allocation id and amounts, completion year, transfer date, each capitalised item by `sourceType`, `sourceId`, `sourcePosition` and amount);
  - the applied `ruleCode@version`s (the start check of P7-D1 covers them);
  - `recordedAt`, the actor and a `reason`.

  It is never changed or deleted. A new one supersedes it; both stay readable.
- **Reproducible:** a test recomputes a recorded version from its recorded inputs and gets its entries exactly.
- **In the view:**
  - `DEPRECIATION_SCHEDULE_NOT_RECORDED` (open) while no version is recorded for the asset;
  - `DEPRECIATION_CHANGED_SINCE_RECORDED` (open) on each year whose derived amount differs from the latest recorded version, with both amounts and the components that differ.
  
  So a year becomes final only when the AfA a person recorded is the AfA DE derives. **Alternative:** the first flag informative, so that recording is optional.
- **Not a snapshot:** a recorded schedule version is the Depreciation domain's record (data-model §39), not an `InvestmentMetricSnapshot` (ADR-040, Phase 9).
- **Needs the user:** yes (1, 2 or 3; and whether "not recorded" is open).
- **Decided (2026-10-30):** option 3. The schedule is computed on read and recorded as versions. `DEPRECIATION_SCHEDULE_NOT_RECORDED` and `DEPRECIATION_CHANGED_SINCE_RECORDED` are both **open** flags, so a year is final only once its AfA is recorded.
- **Specified (VC-8-04, api-design §60):** a version per asset covers every year from the schedule's first year up to a chosen `throughYear`, all owners included; it stores the derivation's inputs (asset facts, components with their source ids and basis inputs, owner parts with their fractions and tenure, rule versions with a rule-version hash) and its output (entries per year, component and owner part) as rows of migration 0052, append-only (only `CURRENT` → `SUPERSEDED`); it is recomputed on read (`RECORDED_VERSION_NOT_REPRODUCIBLE` if not equal). "Changed since recorded" compares per year a SHA-256 fingerprint of the inputs truncated to that year, and the year's output. Recording needs every year of the run computable; open flags on computed figures do not block it (proposal, §60 open question 1); a recorded year whose figures change must be named (`acceptChangedYears`). `DE_AFA_BUILDING_LINEAR@1` and `DE_AFA_MOVABLE_LINEAR@1` freeze with VC-8-04's implementation.

### P8-D11 Rules and the domain boundary (ADR-041, P7-D1; AGENTS.md §26)

- **A Depreciation domain** (`domains/depreciation/`), as AGENTS.md §26 lists it: the asset, the basis components, the schedule, the recorded versions. It reads the Acquisition, the allocation and the Ownerships through their domains, and the `capitalized` items through the Taxation domain's derivation, never their tables directly. The tax-year view (Taxation) reads the schedule through the Depreciation domain's index.
- **Its rules** are modules in `domains/depreciation/rules/` with the fields of `rule-version.ts`:
  - `DE_AFA_BUILDING_LINEAR@1` and `@2` (2006–2022 and from 2023, §59A "The rule versions"; § 7 Abs. 4 S. 1 Nr. 2 and S. 2, § 7 Abs. 1 S. 4 EStG): the bands, the first year, the end, `subsequentCostStart` (P8-D6), `endMonthCounts` (P8-D9);
  - `DE_AFA_MOVABLE_LINEAR@1` (§ 7 Abs. 1 EStG) if P8-D7 adopts option 1.
- **One registry:** they are registered in the existing `TAX_RULES` registry, so `GET /tax-rules` lists them and the start check resolves every `ruleCode@version` a recorded version stores. A second registry would need a second start check and a second listing.
- **Where the registry lives** (decided by VC-8-01's spec, api-design §59, review on #174): not in `domains/taxation/rules/registry.ts`, which could reach the Depreciation rules only by a deep import (refused by `architecture.test.ts`) or through `depreciation/index.js` (a runtime cycle with Depreciation, which needs the registry as a value). `RuleVersion` (`rule-version.ts`) and the class `RuleRegistry` move to `shared/`. Each domain keeps its rule modules and exports its versions through its index (`TAXATION_RULE_VERSIONS`, `DEPRECIATION_RULE_VERSIONS`). `TAX_RULES` is composed in a new module `domains/tax-rules/`, above both domains; neither domain imports it. A domain function receives the registry as a parameter (injection), as Taxation's functions already do. `GET /tax-rules`, the start check and the Phase-7 code read the same `TAX_RULES`, and only their imports change.
- **Every derived figure names its rule version** (taxation.md §9, depreciation.md §8). A version is never removed while a recorded version names it.
- **Needs the user:** no (for review).
- **Amended by VC-8-03's spec (api-design §59B):** Depreciation and Taxation never import each other (both edges forbidden in `architecture.test.ts`). Each owns the input type it reads, and `infrastructure/postgres/` fills it from the other's derivation in the read's own snapshot: `capitalized-items.ts` maps Taxation's `capitalizedItemsOf` to Depreciation's `CapitalizedItem`, and (VC-8-05) `tax-year-depreciation.ts` maps Depreciation's schedule to the view's AfA input. The view reads the schedule through that adapter, not through a domain edge.

### P8-D12 The tax-year view (completes P7-D8; §58C "The AfA block")

- **The AfA block:**
  - `depreciation: { status, amount, components, reasons }`;
  - `status` is `AVAILABLE` (every component computable), `PARTIAL` (some computable; the rest with their reasons) or `DEPRECIATION_NOT_AVAILABLE` (none);
  - each component names its asset, its source (Acquisition or capitalised item), the basis, the rate, the months of the year, the amount and the rule version, so the figure is traceable as every line of §58C.
- **In the Werbungskosten:** a fixed line `AFA_BUILDING` (and `AFA_SEPARATE_ASSETS` with P8-D7), placed after the lines of §58C, whose items are the components. The Werbungskosten total includes it; `result` = Einnahmen − Werbungskosten, as before (§58C: "Phase 8 fills `amount`, adds it to the Werbungskosten and changes the basis").
- **`result.basis`:**
  - `AFTER_DEPRECIATION` when `status` is `AVAILABLE`;
  - `PARTIAL_DEPRECIATION` when `PARTIAL`;
  - `BEFORE_DEPRECIATION` when `DEPRECIATION_NOT_AVAILABLE`.
- **`DEPRECIATION_NOT_AVAILABLE`** stays an open flag, now only when it holds, with the reasons of P8-D2. `PARTIAL` raises the open flag `DEPRECIATION_INCOMPLETE`. A year before the first transfer has no AfA: `AVAILABLE` with 0.00, no flag.
- **Per owner:** each owner's AfA of P8-D8, and `NOT_OWNED`; owners + `NOT_OWNED` = the property, as every other figure of §58C.
- **`capitalized`** stays listed (§58C), and each item names the component it became.
- **`final`** can become true for the first time: without an open flag, including P8-D10's.
- **Needs the user:** no (for review). The API shape is written out by VC-8-05's spec.

### P8-D13 What Phase 8 does not compute (ADR-024)

- **Degressive AfA, § 7 Abs. 5a EStG** (B4, depreciation.md §4): 5 % of the residual value, for construction begun between 01.10.2023 and 30.09.2029, and for an acquisition only up to the end of the completion year. Out of scope. An asset whose completion year is ≥ 2023 and equals the year of the transfer is flagged `DEGRESSIVE_AFA_MAY_APPLY` (informative): the rest of the conditions DE cannot know. **Amended 2026-10-31** (api-design §59A): a new building bought in its completion year from 2018 is not computable (`DEPRECIATION_METHOD_UNKNOWN`), since § 7 Abs. 5a or § 7b EStG may have been claimed; the informative `DEGRESSIVE_AFA_MAY_APPLY` is withdrawn.
- **Sonder-AfA, § 7b EStG:** not covered by `depreciation.md` (the checklist only warns that such time-limited rules age fast). Out of scope; **VERIFY** whether it matters to the user at all.
- **Denkmal- and Sanierungs-AfA, § 7h/§ 7i EStG** (B10, depreciation.md §6): optional for the MVP, "als eigenes RuleSet". Out of scope; a later item.
- **Not covered by `depreciation.md`, so not computed:** the successor's continuation of AfA after an inheritance or gift (§ 11d EStDV; P8-D8 flags it), extraordinary AfA (AfaA, § 7 Abs. 1 S. 7 EStG), a self-built building (its start at completion, B6), business assets and Wirtschaftsgebäude (depreciation.md §3: out of scope), months of own use.
- **The BMF-Arbeitshilfe** as a computation (P8-D3).
- **A landlord who opted for VAT under § 9 UStG** (input VAT deductible, so the basis is net) is out of scope. DE records no such option and takes the gross amount (P8-D2, reviewer input on #173).
- **Needs the user:** yes, to confirm the scope (in particular § 7b and § 7h/§ 7i).
- **Decided (2026-10-30):** the scope as above, taken as recommended. The user can still change it in review.

### P8-D14 Conventions carried over (as P7-D9)

- Creates take `Idempotency-Key` (§15), changes take `If-Match` (§16.1), and every write writes an AuditRecord. Every row is Realm-scoped by composite foreign keys.
- **Lock order:** an asset write locks the PropertyReference as a no-op write (as every Ownership writer, §26.1), then the asset. Recording a version reads its inputs in one `REPEATABLE READ` snapshot and writes in the same transaction, so a version never mixes two states.
- **Reads** are derived in one `REPEATABLE READ READ ONLY` snapshot (P7-D8), and write nothing.
- **No cash, ever:** no command of Phase 8 writes a Transaction or a split (AGENTS.md §7, §17). A test compares the ledger, its splits and their versions before and after every Phase-8 command.
- No MRE call.

---

# 2. Items

See `backlog.md` §3g. Each item starts with a spec PR for its API section, as in Phases 2–7. The order follows the dependencies.

1. **VC-8-01: the asset and its rule** (P8-D1, P8-D4, P8-D11).
   - **Spec:** api-design §59 rewritten (replacing the placeholder): `POST /api/v1/depreciation-assets`, `GET …/{id}`, amend, confirm, void, `GET /api/v1/property-references/{id}/depreciation-assets`. Data-model §38 rewritten (P8-D1); domain-model §49; the registry entry in §58.
   - **Code:** migration (the asset table, the unique index on the building per PropertyReference); `DE_AFA_BUILDING_LINEAR@1` registered; the start check covering it.
   - **Tests:** the bands at 1924/1925 and 2022/2023; a year before 2023 `NO_APPLICABLE_RULE`; one building per PropertyReference; Realm isolation; Idempotency-Key, If-Match, AuditRecords.
   - **Counter-checks:** no basis, rate or schedule stored on the asset (the table has no such column); a completion year never guessed.
   - **Depends on:** this plan. The shorter useful life is included (P8-D4 decided).
   - **Status:** specified (api-design §59; migration 0049 planned).
2. **VC-8-02: the schedule of the purchase** (P8-D2, P8-D3, P8-D5, P8-D8, P8-D9).
   - **Spec:** api-design §59A: `GET /api/v1/depreciation-assets/{id}/schedule[?ownerPartyId=]`, derived: the components of P8-D2 (1), years, months, amounts, Restbuchwert, per owner and `NOT_OWNED`, the rule versions, the flags. The shared basis function with §58B.
   - **Tests:**
     - the first year for each transfer month (January 12/12, April 9/12, December 1/12) and `TRANSFER_DATE_ASSUMED`;
     - the last year's remainder and the cap at the basis;
     - cumulative rounding: a basis with an odd cent never drifts over 50 years;
     - `FINANCING_RELATED` left out; land never in;
     - each `NOT_COMPUTABLE` reason;
     - per owner: §27.4's weights, a partial acquisition, a reduced share, `OWNER_WITHOUT_ACQUISITION`, the disposal year as P8-D9 decides;
     - a property test: owners + `NOT_OWNED` = the property, every year sums to the basis;
     - the basis equals §58B's for the same Acquisition.
   - **Counter-checks:** land included; a `DRAFT` Acquisition or an unconfirmed allocation feeding a figure; the transfer month not counted, or the month before counted.
   - **Depends on:** VC-8-01; the VERIFY point of P8-D9 for the disposal year.
   - **Status:** implemented (api-design §59A, "As implemented (VC-8-02)"; no migration). **Decided by the owner on 2026-10-31** (§59A "Decided on 2026-10-31"): the rule follows the completion year, never the purchase date or the year computed; years 2006–2022 are computed with an earlier rule version (`DE_AFA_BUILDING_LINEAR@1`, today's version renumbered `@2`) and flagged `HISTORICAL_RULE_TO_VERIFY` until the tax advisor confirms it; a contract or start before 2006 is `HISTORICAL_RULE_NOT_SUPPORTED` and a new building bought in its completion year from 2018 `DEPRECIATION_METHOD_UNKNOWN` (not computable: DE never switches a running historical method); the disposal year pro rata up to the buyer's transfer of economic ownership (the month counts in full), `PROVISIONAL` with `DISPOSAL_YEAR_TO_VERIFY`, and not computable without that date (`DISPOSAL_DATE_MISSING`); a missing figure is `null`, never 0.00, with `calculationStatus` `NOT_CALCULABLE` / `PROVISIONAL` / `CALCULATED`. An existing owner's additional share: VC-X-30 (§28.1A). Open: the start without `economicTransferDate` (§59A open question 6).
3. **VC-8-03: capitalised costs and separate assets** (P8-D6, P8-D7).
   - **Spec:** §59A extended by the components of P8-D2 (2); §59B for `SEPARATE_ASSET` (create naming items, amend, void) if P8-D7 adopts option 1; `DE_AFA_MOVABLE_LINEAR@1`.
   - **Tests:**
     - a capitalised item from the chosen start (P8-D6);
     - a refund of Herstellungskosten lowering the basis;
     - an anschaffungsnahe capitalisation in year 3 changing years 1–3;
     - a suggested `CAPITALIZED` not counted;
     - an item in a separate asset leaving the building, and the unique index;
     - a kitchen over 10 years with the month rule;
     - the components of every year equal the `capitalized` items up to it.
   - **Counter-checks:** an item in the Werbungskosten and the basis at once; an item in two assets.
   - **Depends on:** VC-8-02; the VERIFY points of P8-D2 (VAT) and P8-D6 (start).
   - **Status:** specified (api-design §59B; migration 0051 planned). The start **proposed** (`START_OF_YEAR`, flagged `SUBSEQUENT_COST_START_TO_VERIFY`, §59B open question 1, not decided by the owner); the end after the purchase is exhausted and with a shorter life to verify (open question 2); separate assets acquired before 2023 `NO_APPLICABLE_RULE` (open question 4); the no-cycle path through `infrastructure/postgres/` (P8-D11 amended).
4. **VC-8-04: recorded schedule versions** (P8-D10).
   - **Spec:** api-design §60 rewritten: `POST /api/v1/depreciation-assets/{id}/schedule-versions` (with `reason`), `GET …/schedule-versions`, `GET …/schedule-versions/{versionId}`; data-model §39–§40 rewritten (the input components as rows).
   - **Code:** migration (versions, entries, input components; append-only, guarded by a trigger as 0009 and 0013 freeze a confirmed Transaction).
   - **Tests:**
     - reproducibility: a version recomputed from its recorded inputs gives its entries exactly;
     - a version never changed or deleted (the trigger, past the repository);
     - its rule references resolved by the start check;
     - `DEPRECIATION_CHANGED_SINCE_RECORDED` after a superseding allocation, a completion year amended, a source capitalised;
     - RC/RR on two concurrent records.
   - **Counter-checks:** a record replacing the previous version's entries; a version mixing two snapshots.
   - **Depends on:** VC-8-02 (VC-8-03 for capitalised components).
   - **Status:** specified (api-design §60; migration 0052 planned; data-model §39–§40 rewritten). The unit is the asset with every year up to `throughYear` (§60 open question 2); the inputs and the output stored as rows, append-only, reproducible from them; per-year input fingerprints for "changed since recorded", including input changes that move no amount (open question 3); `POST` with `throughYear`, `reason` and the schedule's `expectedInputFingerprint` (`412 SCHEDULE_CHANGED`), refused while a year of the run has no figure (`SCHEDULE_NOT_COMPLETE`), allowed with open VERIFY flags (proposal, open question 1), and naming every recorded year it changes (`acceptChangedYears`, open question 4); one `REPEATABLE READ` transaction with up to three retries, then `503 CONCURRENT_UPDATE` as the repository's other exhausted retries; child rows appended only in the transaction that created the version (its stored `created_txid`, not `xmin`); the two AfA rules frozen, a hash over every field of a rule version but `effectiveTo`, computed through a domain port with `node:crypto` in `infrastructure/` only, a test there pinning the hash of every frozen version, and the start check reading the recorded references and their hashes. The VERIFY answers of §59A question 3 and §59B questions 1–2 should come before the freeze; §60 open question 5 proposes them as a **hard gate for VC-8-04's implementation**, for the project owner to decide (after the freeze the years under `@1` keep their open flags for good).
5. **VC-8-05: the AfA in the tax-year view** (P8-D12).
   - **Spec:** api-design §58C amended: the AfA block, the lines `AFA_BUILDING` (and `AFA_SEPARATE_ASSETS`), `result.basis`, the flags of P8-D2, P8-D10 and P8-D12 in the review table, `final`.
   - **Tests:**
     - the three statuses and three bases;
     - the AfA line traceable to its components;
     - the result moved by exactly the AfA;
     - per owner the schedule's per-owner amounts;
     - `final` true for a year without open flags and false with each of them;
     - the view and the schedule read in one snapshot.
   - **Counter-checks:** "no cash mutated" extended to the Depreciation tables; a year with `LOAN_INTEREST_NOT_ATTRIBUTED`, `ATTRIBUTION_INPUT_CHANGED` or `ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL` never final.
   - **Depends on:** VC-8-02 to VC-8-04.
   - **Status:** specified (api-design §58C, "VC-8-05: the AfA in the view"; no migration); builds on §60 (VC-8-04, specified in #180). The view reads every `ACTIVE` asset's live schedule and its `CURRENT` recorded version through `infrastructure/postgres/tax-year-depreciation.ts` into Taxation's own input type `TaxYearDepreciation`, inside `readTaxYear`'s one snapshot (no domain edge; Taxation → Depreciation forbidden once VC-8-03 adds §59B's edge, not yet on main; `capitalizedItemsIn` takes the source reader `capitalizedSources` as its sixth parameter, as §59B now specifies, so `infrastructure/postgres/` has no module cycle either). Two fixed lines `AFA_BUILDING` and `AFA_SEPARATE_ASSETS` after `OTHER_EXPENSE` (proposal), items = the computed components, a new `line` field (`taxCategory` `null` on them); per owner the schedule's parts, never re-split; `capitalized` unchanged, each item naming its component or `NO_ASSET`; `depreciation: { status, amount, assets, gaps, note }` (deviating from P8-D12's `components, reasons`), gaps = the schedule's reasons, `OWNER_WITHOUT_ACQUISITION` (once, as a gap) and the new `NO_ASSET`; `result.basis` by status; the live figure shown and the recorded version compared (§60's flags, open; `RECORDED_VERSION_NOT_REPRODUCIBLE` a proposal, §60 open question 7); `final` only without any open flag or gap, the blocking list written out; the cap counts the AfA components (proposal). Proposals for review: §58C VC-8-05 open questions 1–6. ACC8 pointer: under the VERIFY proposals 2027 stays not final by `SUBSEQUENT_COST_START_TO_VERIFY` (unless verified before the freeze, §60 open question 5); ACC8 should assert 2026 final.
6. **VC-8-06: the Phase-8 invariant suite, ACC8, and "Phase 8 done".**
   - invariant-suite §46–§50: one section per item, and §50 "Phase 8 exit" with ACC8 (below);
   - `phase-8-acceptance.e2e.test.ts`;
   - the roadmap's status lines of Phase 7 (the AfA figure delivered) and Phase 8;
   - backlog §3g.
   - **Depends on:** VC-8-01 to VC-8-05.

### ACC8 (sketch; synthetic values only)

One scenario through the API, against PostgreSQL and the fake MRE, figures hand-computed in invariant-suite §50 and checked literally. The values below assume P8-D3 option 1, P8-D8 option 1 and P8-D10 option 3. Where a decision is still open, the scenario shows its alternatives.

- **The purchase, mid-year:**
  - one unit of a WEG; an Acquisition with price 300,000.00, Grunderwerbsteuer 15,000.00, notary and land registry 3,000.00, and a `FINANCING_RELATED` cost of 1,200.00;
  - contract 2026-05-20, `economicTransferDate` **2026-07-01**;
  - a confirmed allocation: total 318,000.00, land 63,600.00, building 254,400.00;
  - two buyers, A `3/5` and B `2/5`, from 2026-07-01;
  - the asset `BUILDING`, completion year 1995, confirmed.
- **The schedule of the purchase:**
  - basis 254,400.00, the same as the anschaffungsnahe check's; rate 2 %; annual 5,088.00;
  - **2026: 6/12 = 2,544.00** (A 1,526.40, B 1,017.60); 2027: 5,088.00 (A 3,052.80, B 2,035.20);
  - the `FINANCING_RELATED` cost and the land in no component.
- **The year boundary:**
  - **variant 1,** transfer **2026-12-31**: 2026 is 1/12 = 424.00 (the month counts in full);
  - **variant 2,** transfer **2027-01-01**: 2026 has no AfA, and 2027 is 12/12;
  - **a capitalised item booked on 2027-12-30** counts by its date (P8-D6), whatever the 10-day rule does to cash around it.
- **The anschaffungsnahe check crossing 15 %:**
  - threshold 38,160.00 (15 % of 254,400.00);
  - a repair on 2027-03-10, gross 35,700.00 with `netAmount` 30,000.00, classified `DEDUCTIBLE`: the sum is 30,000.00, not above;
  - a Sonderumlage use on 2028-02-15 of 9,000.00, classified `DEDUCTIBLE`: the sum is 39,000.00, `ABOVE_THRESHOLD`, `affectedYears` [2027, 2028];
  - **before the user acts:** the AfA is unchanged, both sources stay in the Werbungskosten with the open flag, and neither year is final;
  - **after both are capitalised** on the check:
    - the repair leaves 2027's `MAINTENANCE` line, and the use leaves 2028's `WEG_SPENDING`;
    - the basis gains 35,700.00 (gross, if P8-D2's VAT point is confirmed) and 9,000.00;
    - the AfA gains 714.00 a year from the repair and 180.00 a year from the use, from the start P8-D6 decides: with option 1, 714.00 in 2027 and 180.00 in 2028; with option 2, 595.00 (10/12) and 165.00 (11/12);
    - the recorded version of 2027 now differs: `DEPRECIATION_CHANGED_SINCE_RECORDED`, naming the repair.
- **A later capitalised cost**, outside the window: an extension on 2030-09-15 of 12,000.00, classified `CAPITALIZED`, adds 240.00 a year at the building's rate (B11), from the start P8-D6 decides.
- **Per owner:** A + B = the property for every year, line and result, to the cent; at least one component with an odd cent, so the largest remainder and the cumulative rounding show.
- **The view:**
  - **2026:** `AFTER_DEPRECIATION`, `AFA_BUILDING` 2,544.00, the result lower by exactly that;
  - **2027 before recording:** `DEPRECIATION_SCHEDULE_NOT_RECORDED` open; **after recording:** final when nothing else is open;
  - **a year with interest booked via a Loan** (as in ACC7): `LOAN_INTEREST_NOT_ATTRIBUTED` keeps it from being final.
- **Variants:**
  - no confirmed allocation: `DEPRECIATION_NOT_AVAILABLE`, `BEFORE_DEPRECIATION`;
  - a second Acquisition (of a share) whose allocation is not confirmed: `PARTIAL_DEPRECIATION`, the first component computed, the second named with its reason;
  - after P8-D9's VERIFY: B sells to C effective 2029-07-01, B's AfA of 2029 as decided, and C's own component from C's Acquisition.
- **Realm isolation:** every Phase-8 route called with another Realm's ids is `404`, as ACC7's table.

**Counter-checks** within ACC8, each an assertion that the system refuses or excludes the thing:
- **AfA as cash:** every row and version of `ledger_transaction` and `transaction_split` is unchanged by every Phase-8 command; no split of the AfA exists;
- **land in the basis:** the basis is 254,400.00, not 318,000.00;
- **a source counted twice:** a capitalised source is in no Werbungskosten line in any year;
- **a suggestion moving money:** above 15 %, nothing moves before the user capitalises;
- **a recorded version changed:** a direct `UPDATE` of a recorded entry is refused;
- **a figure without its components:** the AfA line equals the sum of its components, each with basis, rate, months and rule version.

**Mutations** that must turn ACC8 red (each applied alone, ACC8 run, the code restored):
- the first-year rule off by one month either way (7/12 or 5/12 in place of 6/12; 2/12 or 0/12 for 31 December);
- the band boundary at 2023 made inclusive of 2022, and the 1925 boundary moved (domain test; ACC8 with 1995 keeps 2 %);
- the building ratio dropped (land in the basis);
- `FINANCING_RELATED` counted;
- a suggested `CAPITALIZED` counted in the basis;
- a capitalised item left in the Werbungskosten as well;
- the owners' parts floored with the rest dropped (A + B ≠ the property);
- the cap at the basis removed (domain test: a short useful life past its end);
- `result.basis` left at `BEFORE_DEPRECIATION`, or the AfA not subtracted;
- a recorded version overwritten in place;
- the Realm filter dropped from the asset read.

**Out of scope for Phase 8:**
- the items of P8-D13;
- the attribution of an allocated Loan's interest (VC-X-29);
- the acknowledgement of attribution changes (VC-X-28);
- maintenance paid from the Hausgeld in the 15 % check (VC-X-27);
- snapshots, reports and dashboards (Phase 9);
- ELSTER or an official form (whole euros on the form are the user's to round);
- market values (ADR-021).

---

# 3. Verification

`depreciation.md` is v0.2, verified on 29.10.2026 (checklist B). This plan relies on:
1. **B1–B3:** the bands by completion: 3 % after 31.12.2022, 2 % from 1925 to 2022, 2.5 % before 1925 (P8-D4).
2. **B5:** only the building, with its share of the acquisition costs; land never (P8-D2).
3. **B6:** the first year less 1/12 per full month before the acquisition month; the start at the transfer of economic ownership (P8-D5).
4. **B7:** a shorter useful life by § 7 Abs. 4 S. 2; the 2023 BMF letter repealed, its requirements not encoded (P8-D4).
5. **B8, B9:** the Einbauküche over 10 years; GWG up to 800 € net deducted at once, no Sammelposten (P8-D7).
6. **B4, B10:** degressive AfA and § 7h/§ 7i, both out of scope (P8-D13).
7. **B11:** later acquisition or production costs raise the basis and follow the building's method (P8-D6).
8. **A2, A3, A6, E2:** the anschaffungsnahe Herstellungskosten, the purchase-price split and the acquisition costs, as Phase 7 uses them (P8-D2, P8-D3).

**VERIFY with the tax advisor before the item that needs it is specified** (not covered by `depreciation.md`; DE never guesses):
1. **The start of a later cost** (P8-D6), for anschaffungsnahe and other Herstellungskosten (VC-8-03).
2. **The year of disposal:** whether the month of the end counts (P8-D9; VC-8-02).
3. **Non-deductible VAT in the basis** (§ 9b Abs. 1 EStG; P8-D2; VC-8-03).
4. **Bands b and c before 2023** (P8-D4; a second rule version).
5. **A co-owner's AfA on their own acquisition cost** (P8-D8), and a successor's continuation (§ 11d EStDV; out of scope until verified).
6. **A shorter useful life:** from the start or from the year evidenced (P8-D4).
7. **§ 7b EStG:** whether it matters at all (P8-D13).
8. **The end of a later cost** (VC-8-03, §59B): whether later Herstellungskosten run as their own series or as one pooled basis once the purchase's basis is exhausted (proposal: pooled, R 7.4 Abs. 9 S. 1 EStR as quoted on #179), whether the building's remaining useful life then takes over (S. 2), and how they run under a shorter useful life.
9. **Later costs of a movable separate asset**, and `DE_AFA_MOVABLE_LINEAR` in years before 2023 (VC-8-03, §59B).

**Still case-dependent, so the user decides and DE never guesses:**
- the completion year and its source;
- the land/building split and its method (A3);
- Erhaltungsaufwand vs. Herstellungskosten, as in Phase 7;
- whether a capitalised item is a separate asset, and its useful life.

**Questions for the review of this plan** (the decisions marked "needs the user"). Questions 1–7 were answered on 2026-10-30 (the **Decided** lines in §1; question 7 below).
1. **P8-D10:** derived and recorded (option 3)? And is "not recorded" an open flag, so that a year is final only once its AfA was recorded?
2. **P8-D8:** the AfA per Acquisition among its buyers (option 1)?
3. **P8-D7:** separate assets in Phase 8 (option 1), or only marked and flagged (option 2)?
4. **P8-D4:** the shorter useful life in Phase 8?
5. **P8-D3:** the allocation as entered, without a BMF computation?
6. **P8-D13:** the scope, in particular § 7b and § 7h/§ 7i out?
7. **VC-X-28 and VC-X-29** (P8-D12): the backlog says both come "before Phase 8 makes a year final". They do not block Phase 8: their flags (`ATTRIBUTION_INPUT_CHANGED`, `LOAN_INTEREST_NOT_ATTRIBUTED`) stay open, so a year they touch is never final. Phase 8 does not need loan interest to compute AfA. **Proposal:** keep them outside Phase 8, and schedule VC-X-29 next, since a landlord with a financed purchase has interest booked via a Loan in every year. The alternative is to pull them into Phase 8 before VC-8-05. **Decided by the project owner (2026-10-30); the review on #173 agreed:** they do not block Phase 8; VC-X-29 is scheduled next.

---

# 4. Risks and open questions

- **An additional share bought by an existing owner may not be representable.** A holds `1/2` and buys B's half: §26.2 closes A's `1/2` and creates A's `1/1`. That Ownership would carry the new Acquisition's id, but §28.1 requirement 5 needs its share to equal `acquiredShare` (`1/2`). A second `1/2` Ownership for A would overlap the first, which §12.4 forbids. The per-buyer AfA (P8-D8) needs this case. **Open:** VC-8-02's spec checks it against the code first. If it holds, it is a Phase-2 gap to decide (a weight per Ownership and Acquisition, or two Ownerships allowed), not a guess in the Depreciation domain. **Checked (VC-8-02, api-design §59A):** it holds. `1/1` carrying the new Acquisition fails requirement 5 (`SHARE_SUM_MISMATCH`, `structureViolations` and migration 0022), a second `1/2` fails the overlap rule (`OVERLAPPING_OWNERSHIP`, migration 0019). The schedule flags such a purchase `BUYER_ALREADY_OWNER` (open, not computed); the minimal change (the bought part as the increase over the day before) is open question 1 of §59A.
- **Earlier years change.** A crossing of 15 % in year 3, a superseding allocation or a corrected completion year changes the AfA of filed years. P8-D10 makes it visible. DE does not know which years were filed, as with §58C's `ATTRIBUTION_INPUT_CHANGED`.
- **`final` becomes reachable.** Every open flag of Phase 7 now matters, since a year can be presented as final for the first time. VC-8-05 tests `final` against each open flag of the review table, not only the new ones.
- **The completion year is often unknown** for older buildings in a WEG. The asset then stays without a rate and the AfA `DEPRECIATION_NOT_AVAILABLE`, never a default year.
- **Five VERIFY points** gate VC-8-02 and VC-8-03 (§3). If the advisor's answers are late, VC-8-01 can proceed; the rule parameters wait. VC-8-04 freezes the rule versions, so §60 open question 5 proposes the answers as a hard gate for its implementation (the owner's decision).
- **The view grows:** the AfA reads every `capitalized` item since the transfer, not only the year's. A private landlord's numbers are small; VC-8-05 checks the query plan as VC-7-04 did.
- **Rounding on the form:** ELSTER takes whole euros; DE keeps cents. Out of scope (P8-D13), named so it is not mistaken for an error.
- **The placeholders of api-design §59–§60** (`correct-basis`, `recalculate`) do not fit P8-D1 and P8-D10: the basis is never corrected on the asset, only through its inputs. VC-8-01 and VC-8-04 replace them.
