# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Mystics Inventory

Multi-tenant SaaS inventory management web app for Indian SMBs (Zoho-Inventory style). Lives in `artifacts/inventory` (web) and `artifacts/api-server` (API). Schema in `lib/db/src/schema`, generated API client in `lib/api-client-react`.

### Conventions
- **Auth**: Clerk (`@clerk/express` on backend; `@clerk/react` on frontend). On first `/api/me` hit, the backend auto-creates `users` row + a personal `organizations` row + `organization_members` link + a `Main Warehouse`. 14-day trial begins immediately.
- **Multi-tenancy**: Every backend query MUST be scoped by `req.tenant.organizationId` (set by `tenantMiddleware`). For any incoming foreign id (item/customer/supplier/warehouse), call `assertOwnership({...})` from `src/lib/tenant.ts` before using it.
- **Numeric**: Postgres `numeric` columns are exposed as strings by Drizzle. Use `toNum`/`toStr` from `src/lib/numeric.ts` and the serializers in `src/lib/serializers.ts` to convert at the API boundary.
- **Order numbering**: `SO-YYMMDD-NNNN` for sales orders, `PO-YYMMDD-NNNN` for purchase orders (helpers in `src/lib/orderHelpers.ts`).
- **Stock transfers**: Warehouse-to-warehouse moves live in `stock_transfers` + `stock_transfer_lines` (number prefix `TRF`). Status flow `draft` → `in_transit` → `completed`, with `cancelled` reachable from `draft` or `in_transit`. Endpoints: full CRUD plus `POST /stock-transfers/:id/dispatch|complete|cancel`. Dispatch validates source on-hand under `FOR UPDATE`, decrements source and writes `transfer_out`; complete increments destination and writes `transfer_in`; cancel from `in_transit` re-credits source via `transfer_cancelled`. All movements use `referenceType="stock_transfer"`. Each touched item triggers `pushStockToShopify(orgId,itemId)` after the txn commits.
- **Bundles (composite items)**: An item with `is_bundle=true` carries its own SKU/price/tax but no physical stock — components live in `item_bundle_components` (parentItemId, componentItemId, quantityPerBundle; unique on (parent, component)). Constraints: a bundle cannot also be `hasVariants` and cannot be a variant child; components must be leaf items (no parents, no bundles — one level deep). PATCH replaces the component set in a transaction; toggling `isBundle=false` clears components in the same txn. Enabling bundle requires a non-empty components array in the same request, and an existing bundle cannot be patched to an empty components list. Bundle stock is **derived** per warehouse as `floor(min(componentStock(c, wh) / quantityPerBundle))` and summed for totals; helpers in `src/lib/bundles.ts` (`computeBundleStockByWarehouse`, `computeBundleTotalStock`, `computeBundleTotalsForMany`). `assertNoBundleItems`/`findBundleItems` in `src/lib/tenant.ts` are used to reject bundles in PO/transfer/adjust-stock create+patch and re-checked at goods-receipt, transfer-dispatch and transfer-complete time so toggling an item to bundle mid-flow can't violate the no-physical-stock rule. Shipping a bundle line fans out per component: one `shipmentLines` row at the bundle qty, but stock writes & `stockMovements` rows are at the component level (`qty * quantityPerBundle`). Cancellation reverses **deterministically**: it reads every original `sale` `stockMovements` row for the shipment and increments each (item, warehouse) by the original quantity's negation, so reversal is correct even if the bundle was later toggled off or its components changed. Shipment `decrementStock`/`incrementStock` use atomic SQL `quantity = quantity ± delta::numeric` so concurrent ship/cancel writes on the same cell don't lose updates. Shopify outbound (`pushStockToShopify`) detects bundles and pushes the **derived** per-warehouse stock for them (via `computeBundleStockByWarehouse`); for physical items it pushes the row's quantity as before.
- **Stock movements**: Sales orders ship via the `shipments` entity — `POST /sales-orders/:id/shipments` records a partial or full shipment, decrements warehouse stock, and writes stock_movements with `referenceType="shipment"`. The order's status (`confirmed` / `partially_shipped` / `shipped`) is **derived** from per-line `quantityShipped` totals; `PATCH /sales-orders/:id/status` rejects `shipped`/`partially_shipped` and refuses to cancel orders with any recorded shipments. `POST /shipments/:id/cancel` reverses stock and re-derives status. Returns reverse based on `quantityShipped` per line. Purchase orders mirror the same shape via the `goodsReceipts` entity — `POST /purchase-orders/:id/goods-receipts` records a partial or full receipt (number prefix `GRN`), increments warehouse stock, and writes stock_movements with `movementType="purchase"` and `referenceType="goods_receipt"`. The PO status (`ordered` / `partially_received` / `received`) is **derived** from per-line `quantityReceived` totals; `PATCH /purchase-orders/:id/status` rejects `received`/`partially_received`, blocks cancel when active receipts exist, and blocks revert from `billed`/`paid`. `POST /goods-receipts/:id/cancel` reverses stock and re-derives status. Returns reverse based on `quantityReceived` per line (the legacy `stockAppliedAt` claim path has been removed).
- **Subscription**: Razorpay subscriptions, INR (paise). Tiers: free / starter / growth / scale (in `src/lib/plans.ts`). `/subscription/checkout` creates a plan + subscription and stores `razorpaySubscriptionId` on the org with status `pending`. `/subscription/verify` checks the org's pending subscription matches AND HMAC SHA256 of `paymentId|subscriptionId` matches before activating.
- **Barcode scanner**: Items have an optional `barcode` column (per-org index). `GET /items/lookup?code=...` resolves a scanned/typed code to an item, preferring `barcode` then `sku`. The reusable `BarcodeScannerDialog` (`@zxing/browser`) is embedded in the items search bar (jumps to the matched item or seeds the search), the create/edit item form, the bulk import (`barcode`/`ean`/`upc`/`gtin` aliases), and the goods receipt + shipment dialogs (scanned items bump the matching line's quantity by one).
- **Shopify**: Public-app OAuth flow. `POST /shopify/oauth/install` (auth'd) returns an `installUrl` after generating + storing a one-time state in `shopify_oauth_states`; `GET /shopify/oauth/callback` (public, mounted before `clerkMiddleware` in `routes/shopifyOauthCallback.ts`) verifies HMAC + state, exchanges the code, validates that all `REQUIRED_SCOPES` were granted, resolves the primary location, registers webhooks, and redirects back to `/integrations/shopify?connected=1`. `POST /webhooks/shopify` (also pre-Clerk) verifies HMAC against the raw body, dedupes per-org by `X-Shopify-Webhook-Id` (only PG `23505` counts as duplicate; other DB errors propagate so Shopify retries), and dispatches `orders/create`, `inventory_levels/update`, `products/update`, `app/uninstalled`. `importShopifyOrder` runs in a single transaction so partial failures roll back. Stock changes from items/sales/purchase routes call fire-and-forget `pushStockToShopify(orgId,itemId)` from `lib/shopifyOutbound.ts`, which serializes per-(orgId,itemId) and coalesces concurrent requests so Shopify never gets stale overwrites.

### Frontend
- React + Vite + wouter + tanstack-query + shadcn/ui at base path `/`. App shell in `src/components/AppShell.tsx`. Sidebar nav links use `data-testid="link-nav-{slug}"`. Page headers use `text-page-title`. Stat cards use `text-stat-title-{slug}` / `text-stat-value-{slug}`.
- Clerk routes mounted at `/sign-in/*?` and `/sign-up/*?`. `App.tsx` strips wouter `basePath` from Clerk's `routerPush`/`routerReplace`, and `ClerkQueryClientCacheInvalidator` clears `react-query` cache on user change.

### Env
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (set).
- Optional `RAZORPAY_PLAN_FREE/STARTER/GROWTH/SCALE` to pin existing Razorpay plan ids; otherwise plans are created on demand.
