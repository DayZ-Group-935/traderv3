# Catalog edits

Server Owner (`1215040829186383912`) and High Lvl Staff (`1215042184764723251`) in guild `1213578527522431046` can open Admin and edit the calculator catalog. Trader (`1215060053191819324`) can open Trader mode only. Anyone else stays on My account. The page hides Trader and Admin until a fresh membership response allows them. Hiding is not the permission check. `POST /api/catalog` reads the member again and denies anyone else.

The active mode sets the outline: orange for My account, green for Trader, light purple for Admin. A higher role does not keep its color while another mode is selected.

## Price, discount, and stock

Published prices, stock, and catalog discounts stay as they are. A new discount is 0. There is no sample price in the catalog.

A catalog discount is per item and per side, buy or sell. It is either a percent of that unit price or a fixed credit amount, not both. The resulting unit is `round(price * (1 - percent / 100))` or `price - fixed`, and it cannot go below 0.

My account and Trader no longer show role toggles. A calculator role applies only when `pricing_roles` includes its exact name. That list is empty unless a verified Discord role id map names the calculator role. No role id is guessed. Admin edits each role term as a row: the item, buy or sell, a replacement price or a percent or credit discount, and remove. New items are picked from that side of the catalog. A prefilled item that is not on that side stays and is marked not in catalog. Save stays disabled, with one short note, until the catalog store is configured. Calculator terms stay the master and are tagged calculator term. A Discord percent (Click Click Boom 7, Daryl Dixon 15, Deadshot 20, Head Hunter 5, Hotshot 25, Kamikaze 20, Negan 10, Day 1 10) is shown as reference and is not applied when the calculator already defines that role. Day 1 is the calculator role Day One, so its 10% is not added again. A Discord percent applies to buy lines only when that role has no calculator terms, tagged from Discord. A role whose Discord text is ongoing bonuses and no percent has no price effect and is marked no defined terms. Line percents do not stack; the lower price wins. Those terms start from the built-in rules: Roadkill discounts the car parts and not Trader Car or Trader Truck, Dr. Greenthumb replaces Cannabis with 30, All Your Base takes Faction Flags to 0, and Day One is a 10% buy-cart discount that skips lines which already have a catalog discount. A role bonus still replaces the sell unit. Saving them uses `POST /api/catalog` and is refused with 401 or 403 before the store-missing 503.

Role buttons still use their existing percents and bonuses. A role percent is calculated from the same unit price, and the line uses the lower of the catalog result and the role result. The two are not multiplied. A role bonus replaces the sell unit and is not discounted again. Day One's extra 10% still applies to buy lines that have no catalog discount. A line that already has a catalog discount is left out of that extra 10%.

Bible keeps its quantity tiers. Its unit price cannot be replaced. A catalog discount, when one is saved, applies to the tier total. Kit tokens still replace the kit price with 0. Out-of-stock items are shown as unavailable, cannot be added, are left out of new kit choices, and cause an old order link that contains them to fail. A link that still loads is repriced from the current catalog, and the page says when the saved numbers were not current.

## Storage

Writes fail closed until both of these are set on the host:

- `CATALOG_STORE=file`
- `CATALOG_STORE_PATH=/var/data/catalog.json`

The path has to be under `/var/data/`, and that directory has to exist and be writable. The current service does not have this disk. The noted option is a 1 GB disk at `/var/data`, about US$0.25 per month. It is not approved and is not created by this change. Adding it turns off Render zero-downtime deploys. Auto-Deploy stays off. The process does not create the directory or commit catalog data to git.

Saves are atomic (write a temp file in the same directory, then rename). The file stores the revision, the changed rows, and an audit of actor id, actor name, time, and old/new values. It does not store tokens. A stale revision is rejected. A missing or hostile Origin is rejected.
