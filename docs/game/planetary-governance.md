# Planetary Governance

## Population Distribution
- New base gets 200 Pioneers automatically.
- Each base provides life support, safety, and health to population.
- Weekly POPR (population report): workers redistribute evenly among bases based on production line capacity needs.
- Workforce Reserve Pool: 10% held back for instant recruitment during the week (players can pull up to cap).
- Only Pioneers and Settlers can naturally grow; Technicians, Engineers, Scientists emerge through "education" tier shifts (require high happiness in target tier + education infrastructure).
- Unemployment occurs when population > job capacity; reduces happiness.

## Happiness & Growth
- Happiness is 4-week weighted average (most recent week weighted 0.4, older weeks 0.25, 0.2, 0.1, 0.05).
- Derived from need fulfillment (see: Population Needs) + unemployment bonus/penalty + explorer's grace.
- Growth when happiness > 70%; decline when happiness < 50%.
- Explorer's Grace: +50% happiness bonus for first 4 weeks on new planet.

## Administration Center (AC)
- Planetary project built collectively by residents.
- Enables governor elections (2-week terms).
- Governor sets local rules: production fees, local market fees, tax collector (corp or faction).
- Governor runs programs: Immigration, Family Support, Education, Festivities (each costs consumables, one per week, 1-week cooldown).

## Planetary Rules
- **Production Fees**: Per industry/tier, scale with order size. Weighted average for mixed-tier buildings.
- **Local Market Fees**: Base fee + daily time factor (e.g., 100 CIS + 5 CIS/day = 125 CIS for 5-day ad).
- **Tax Collector**: Corporation or faction receives dividend payouts from fees.
- Faction-controlled planets have restricted fee ranges (cannot exceed faction limits).

## Chamber of Global Commerce (CoGC)
- Provides 25% production bonus to chosen industry for duration of active program.
- Members vote on programs (votes weighted by influence = workforce composition with tier multipliers: Pioneer 1x, Settler 1.25x, Technician 1.5x, Engineer 1.75x, Scientist 2x).
- Requires upkeep (DW, MCG, PE, RAT) to stay active; scales with base count.

## Population Needs (Tiers)

Each workforce tier has weighted need priorities. Needs grouped in 4 tiers; higher tiers capped by lowest-fulfilled tier below.

**Tier 1: Life Support** - Always fulfilled on habitable planets, requires habitation on unhabitable.
**Tier 2: Safety & Health** - Provided by bases (50 each) + infrastructure projects.
**Tier 3: Comfort & Culture** - Infrastructure only.
**Tier 4: Education** - Infrastructure + education buildings.

Priorities per tier:
- Pioneers: Life Support, Safety
- Settlers: Life Support, Safety, Health
- Technicians: Health, Safety, Comfort
- Engineers: Comfort, Culture
- Scientists: Education, Culture, Comfort

## Population Infrastructure (POPI)
16 buildings under "Population Infrastructure" project (POPI). Each provides 2 needs, upgradeable to level 10.

- **Small (SST, INF, etc.)**: Provide 2,500 per need when fully filled.
- **Mixed (EMC, PBH, etc.)**: Provide 1,000 per need each.
- **Large (SDP, HOS, etc.)**: Provide 5,000 per need each.

Upkeep consumed daily (reserve = 30 days). Effect scales linearly with upkeep availability (e.g., 4 of 7 days fed = 4/7 effect).

Education infrastructure (PBH +0.001, LIB +0.002, UNI +0.004) boosts education growth rate.

## Government View (context) — what the server sends
- The top-left "视图" switcher on the main screen switches the UI between the company
  context (`#/screen=<id>`) and a government context (`#/context=<adminCenterId>&screen=<id>`).
- In the government context the URL carries the administration center id, and it is listed
  under `USER_DATA.contexts` with `type: "GOVERNMENT"` (the company context is `type: "COMPANY"`).
- **The server only pushes government / planet scoped data in that view.** Login batch
  messages such as `COMPANY_DATA`, `SITE_DATA`, `STORAGE_DATA` are not sent, so stores like
  `companyStore`, `sitesStore`, `storagesStore` stay empty there; global data
  (`UI_DATA`, `MATERIAL_DATA`, …) still arrives.
- Plugin consequence: `prun-api-listener` must not drop messages for a context that belongs
  to the user's own `contexts`, and `initializeApi()` must not wait for company-scoped stores
  in a non-company context — otherwise `features.init()` never runs and neither the theme nor
  any plugin UI loads in the government view.

### 会计数据是「上下文实体」的，不是整个账号的
- Entering a government context re-scopes `ACCOUNTING_*`: `ACCOUNTING_CASH_BALANCES` then
  describes the **administration center's treasury**, not the company. Measured on
  `#/context=4eef…`: `ICA 63,701.91`, `NCC/AIC/CIS = 0` — one funded account, the other three
  currencies exist with zero balances.
- Consequence for `balancesStore`: blindly `setAll()`-ing that payload wipes the company's
  four balances. The bottom-right cash strip then shows only ICA (zeros are filtered), and
  switching back to the company context keeps showing the government figures until the next
  company login. The store therefore only accepts cash balances while the URL context is the
  company context, and keeps a `localStorage` snapshot (`rprun-cash-snapshot`) for the
  government view to fall back on.
