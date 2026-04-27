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
- **Stock movements**: Sales orders ship via the `shipments` entity — `POST /sales-orders/:id/shipments` records a partial or full shipment, decrements warehouse stock, and writes stock_movements with `referenceType="shipment"`. The order's status (`confirmed` / `partially_shipped` / `shipped`) is **derived** from per-line `quantityShipped` totals; `PATCH /sales-orders/:id/status` rejects `shipped`/`partially_shipped` and refuses to cancel orders with any recorded shipments. `POST /shipments/:id/cancel` reverses stock and re-derives status. Returns reverse based on `quantityShipped` per line. Purchase orders mirror the same shape via the `goodsReceipts` entity — `POST /purchase-orders/:id/goods-receipts` records a partial or full receipt (number prefix `GRN`), increments warehouse stock, and writes stock_movements with `movementType="purchase"` and `referenceType="goods_receipt"`. The PO status (`ordered` / `partially_received` / `received`) is **derived** from per-line `quantityReceived` totals; `PATCH /purchase-orders/:id/status` rejects `received`/`partially_received`, blocks cancel when active receipts exist, and blocks revert from `billed`/`paid`. `POST /goods-receipts/:id/cancel` reverses stock and re-derives status. Returns reverse based on `quantityReceived` per line (the legacy `stockAppliedAt` claim path has been removed).
- **Subscription**: Razorpay subscriptions, INR (paise). Tiers: free / starter / growth / scale (in `src/lib/plans.ts`). `/subscription/checkout` creates a plan + subscription and stores `razorpaySubscriptionId` on the org with status `pending`. `/subscription/verify` checks the org's pending subscription matches AND HMAC SHA256 of `paymentId|subscriptionId` matches before activating.
- **Shopify**: Public-app OAuth flow. `POST /shopify/oauth/install` (auth'd) returns an `installUrl` after generating + storing a one-time state in `shopify_oauth_states`; `GET /shopify/oauth/callback` (public, mounted before `clerkMiddleware` in `routes/shopifyOauthCallback.ts`) verifies HMAC + state, exchanges the code, validates that all `REQUIRED_SCOPES` were granted, resolves the primary location, registers webhooks, and redirects back to `/integrations/shopify?connected=1`. `POST /webhooks/shopify` (also pre-Clerk) verifies HMAC against the raw body, dedupes per-org by `X-Shopify-Webhook-Id` (only PG `23505` counts as duplicate; other DB errors propagate so Shopify retries), and dispatches `orders/create`, `inventory_levels/update`, `products/update`, `app/uninstalled`. `importShopifyOrder` runs in a single transaction so partial failures roll back. Stock changes from items/sales/purchase routes call fire-and-forget `pushStockToShopify(orgId,itemId)` from `lib/shopifyOutbound.ts`, which serializes per-(orgId,itemId) and coalesces concurrent requests so Shopify never gets stale overwrites.

### Frontend
- React + Vite + wouter + tanstack-query + shadcn/ui at base path `/`. App shell in `src/components/AppShell.tsx`. Sidebar nav links use `data-testid="link-nav-{slug}"`. Page headers use `text-page-title`. Stat cards use `text-stat-title-{slug}` / `text-stat-value-{slug}`.
- Clerk routes mounted at `/sign-in/*?` and `/sign-up/*?`. `App.tsx` strips wouter `basePath` from Clerk's `routerPush`/`routerReplace`, and `ClerkQueryClientCacheInvalidator` clears `react-query` cache on user change.

### Env
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (set).
- Optional `RAZORPAY_PLAN_FREE/STARTER/GROWTH/SCALE` to pin existing Razorpay plan ids; otherwise plans are created on demand.
