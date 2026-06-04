---
name: Bulk order-number collisions
description: Why bulk inserts of sales/purchase orders must retry on the per-org order-number unique index.
---

# Bulk order inserts collide on order number

`nextOrderNumber("SO" | "PO")` builds numbers as `<PREFIX>-YYMMDD-NNNN` where
`NNNN` is a **random** 4-digit suffix, not a sequence. There is a per-org unique
index on `(organization_id, order_number)` (e.g. `sales_orders_org_number_idx`).

**Why:** Single interactive creates almost never collide, but bulk/batch inserts
(historical Shopify import, future CSV import, seeding) generate many orders that
share the same `YYMMDD`, so the random suffix hits birthday-paradox collisions —
Postgres throws `23505` on the order-number index and the whole insert fails.

**How to apply:** Any code path that inserts orders in bulk must wrap the insert
transaction in a retry loop that regenerates the order number and retries on
`23505` whose `constraint` is the order-number index — and ONLY that constraint
(distinguish from the shopify-order-id dedup index, which means "already
imported" and is handled via `onConflictDoNothing`). Rethrow any other error.
Wrapping the *whole* transaction (not just the insert) keeps stock decrements /
movement rows atomic across retries so side effects never double-apply. See
`artifacts/api-server/src/lib/shopifyOrderImport.ts` for the reference pattern.
