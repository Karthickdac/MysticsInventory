# Mystics vs. Zoho Inventory — Feature Gap Analysis

_Date: 2026-04-27. Scope: full Zoho Inventory feature set vs. the current
Mystics Inventory codebase._

Priority tags used throughout:

- **P0** — must-have for credible parity with Zoho Inventory in the Indian SMB market.
- **P1** — important, expected by most SMBs, but not a deal-breaker for v1.
- **P2** — nice-to-have / differentiator / late-stage polish.

---

## 1. Items, products, SKUs

| Aspect | Zoho Inventory | Mystics today | Gap |
| --- | --- | --- | --- |
| Core item record | SKU, name, description, UoM, HSN, tax rate, sale & purchase price, images | All of these (`items.ts`, `Items.tsx`) | None |
| Multiple images per item | Yes (gallery) | Single image URL | **P1** |
| Item variants (size / colour / material) | Parent product with variant matrix | Supported — parent item with `hasVariants` + 1-3 axes; variants share unit/category/HSN/tax (propagated on parent edit); Shopify multi-variant products import as parent + N variants | Done |
| Composite items / bundles / kits | Yes (BoM-style) | Not supported | **P0** |
| Batch tracking (lot number + expiry) | Yes | Not supported | **P0** for FMCG / pharma; **P1** otherwise |
| Serial number tracking | Yes | Not supported | **P1** |
| Barcode field (separate from SKU) | Yes | Not modeled (SKU doubles up) | **P1** |
| Price lists (multi-currency, customer-tier) | Yes | Single sale price | **P2** |
| Item images via object storage | Yes | URL-only field | **P1** |

---

## 2. Inventory tracking

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Per-warehouse stock | Yes | Yes (`item_warehouse_stock`) | None |
| Stock movements ledger | Yes | Yes (`stockMovements`) | None |
| Manual adjustments with reason codes | Yes | `POST /items/:id/adjust-stock` | None |
| Low-stock alerts (UI + email) | Yes | Dashboard + report only | **P1** (email alert) |
| Reorder points + auto-reorder PO | Yes | Reorder field stored, no automation | **P1** |
| Costing methods (FIFO, LIFO, WAC) | Yes | Implicit / cost = last purchase price | **P1** (FIFO at minimum) |
| Inventory valuation report | Yes | Yes (`reports.ts`) | None |
| Negative-stock prevention setting | Yes (toggle) | Not enforced | **P1** |

---

## 3. Multi-warehouse

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Multiple warehouses per org | Yes | Yes (`warehouses`) | None |
| Default warehouse | Yes | Yes (`isDefault`) | None |
| Warehouse-to-warehouse stock transfers | Yes (transfer order doc) | No dedicated entity (movements only) | **P0** |
| Bin / shelf locations inside a warehouse | Yes | Not modelled | **P2** |
| Per-warehouse permissions | Yes | Not modelled | **P2** |
| Shopify-location ↔ warehouse mapping | N/A (Shopify-specific) | Implemented today | None |

---

## 4. Sales orders, packing, shipping

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Order lifecycle (draft → confirmed → packed → shipped → invoiced → paid) | Yes, with packed/picked sub-states | draft / confirmed / shipped / delivered / invoiced / paid / cancelled / returned | **P1** (no packed/picked states, no partial flow) |
| Partial fulfilment | Yes | Ship-in-full only | **P0** |
| Backorders | Yes | Not tracked | **P1** |
| Picklists, packing slips, shipping labels (PDF) | Yes | None | **P0** (packing slip), **P1** (picklist) |
| Sales returns / RMA | Yes | Yes (status `returned`, reverts stock) | None |
| Drop-ship from PO directly to customer | Yes | Not supported | **P2** |
| Recurring sales orders / subscriptions | Yes | Not supported | **P2** |

---

## 5. Purchase orders & receiving

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Lifecycle (draft → sent → received → billed → paid) | Yes | draft / ordered / received / billed / paid / cancelled / returned | None |
| Partial / multi-receipt against one PO | Yes | Single receipt only | **P0** |
| Bill matching (PO ↔ supplier bill) | Yes | Status only, no bill record | **P1** |
| Expected delivery date + lateness flagging | Yes | Date field only | **P1** |
| Supplier return / debit note | Yes | Yes (status `returned`) | None |
| Drop-ship link to sales order | Yes | Not supported | **P2** |

---

## 6. Customers & suppliers

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Contact record with billing + shipping addresses | Yes | Address as text fields | **P1** (separate billing/shipping) |
| GSTIN, PAN, place of supply | Yes | GSTIN only | **P0** (place of supply for GST split) |
| Payment terms (Net 15 / Net 30 / custom) | Yes | Not enforced | **P1** |
| Credit limit enforcement | Yes | Not enforced | **P1** |
| Outstanding balance tracking | Yes | Field exists, not auto-updated | **P0** |
| Statement of accounts PDF | Yes | None | **P1** |
| Customer / supplier portal | Yes | None | **P2** |

---

## 7. GST invoicing

This is the single biggest parity gap for Indian SMBs.

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| GST-compliant invoice number series (financial-year reset) | Yes | Manual numbering | **P0** |
| CGST / SGST split for intra-state sales | Yes | Single tax rate, not split | **P0** |
| IGST for inter-state sales | Yes | Not split | **P0** |
| Place-of-supply driven CGST/SGST vs. IGST | Yes | Not implemented | **P0** |
| HSN / SAC summary on invoice | Yes (HSN field on item) | HSN stored, not surfaced on invoice | **P0** |
| Reverse charge (RCM) flag | Yes | Not supported | **P1** |
| Composition-scheme invoice format | Yes | Not supported | **P2** |
| E-invoice (IRN + QR code from IRP) | Yes | Not supported | **P0** above ₹5 cr turnover threshold |
| E-way bill generation | Yes | Not supported | **P0** for goods > ₹50k inter-state |
| Invoice PDF generation | Yes | None | **P0** |
| Multi-template / branding | Yes | None | **P1** |
| Email invoice to customer | Yes | None | **P1** |

---

## 8. Payments

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Record customer payment against invoice | Yes | Sales order has `paid` status, no payment record | **P0** |
| Partial payments + allocation across multiple invoices | Yes | Not supported | **P0** |
| Payment links (Razorpay / Stripe) on invoice | Yes (third-party connector) | Razorpay used only for own subscription | **P0** |
| Customer refunds | Yes | Order can be `returned`, no refund record | **P1** |
| Supplier payments (outgoing) | Yes | PO has `paid` status, no payment record | **P0** |
| Bank reconciliation | Yes (via Zoho Books) | Not in scope | **P2** |

---

## 9. Multi-channel integrations

| Channel | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Shopify | Yes | Yes — multi-location stock sync, order import, scope-aware reinstall flow | None |
| WooCommerce | Yes | None | **P1** |
| Amazon (.in seller central) | Yes | None | **P0** for Indian e-commerce sellers |
| Flipkart / Meesho | No (Indian-specific) | None | **P0** |
| Etsy, eBay, Shopee | Yes | None | **P2** |
| Listing creation (push catalog out) | Yes | Manual product mapping | **P1** |
| Cross-channel inventory reservation | Yes | Per-channel only | **P1** |

---

## 10. Shipping integrations

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Shiprocket | Yes | None | **P0** for Indian SMBs |
| Delhivery, Blue Dart, DTDC, Ekart, India Post | Yes (via Shiprocket) | None | **P0** (covered by Shiprocket) |
| AWB / tracking number stored on order | Yes | Not modelled | **P0** |
| Auto-print shipping label | Yes | None | **P0** |
| Live rate-shopping at checkout | Yes | None | **P2** |

---

## 11. Accounting integrations

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Tally export (XML / Excel) | Yes (via 3rd party) | None | **P0** for Indian SMBs |
| Zoho Books sync | Yes (native) | None | **P2** |
| QuickBooks Online sync | Yes | None | **P2** |
| Generic CSV export of vouchers | Yes | None | **P1** |

---

## 12. Reports

| Report | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Stock summary | Yes | Yes | None |
| Inventory valuation | Yes | Yes (last-cost) | **P1** (FIFO/LIFO valuation) |
| Low stock | Yes | Yes | None |
| Sales by item / customer / channel | Yes | Sales summary, top items | **P1** (by customer, by channel) |
| Purchases by supplier | Yes | Yes | None |
| Aging report (receivables / payables) | Yes | None | **P0** |
| Profit & loss (item-level margin) | Yes | None | **P1** |
| GSTR-1 (outward supplies) | Yes | None | **P0** |
| GSTR-3B (summary) | Yes | None | **P0** |
| HSN-wise summary | Yes | None | **P0** |
| Custom report builder | Yes | None | **P2** |
| Scheduled email reports | Yes | None | **P2** |

---

## 13. Automations & workflows

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Email notifications (low stock, new SO, etc.) | Yes | None | **P1** |
| Workflow rules (if X then Y) | Yes | None | **P2** |
| Auto-reorder PO when stock < reorder level | Yes | None | **P1** |
| Custom buttons / fields | Yes | None | **P2** |

---

## 14. Multi-currency

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Per-org base currency | Yes | Field exists | None |
| Per-customer currency | Yes | Not used | **P2** |
| Live FX rates + revaluation | Yes | Not used | **P2** |

For an India-first SMB tool, this is squarely P2.

---

## 15. Multi-tenancy, teams, permissions

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Tenant isolation | Yes | Yes (`organization_id` everywhere + `tenantMiddleware`) | None |
| Roles (owner / admin / staff) | Yes | owner / admin / member | None |
| Granular per-module permissions | Yes | Coarse-grained | **P1** |
| Per-warehouse user scope | Yes | Not supported | **P2** |
| Two-factor auth | Yes (via Clerk) | Yes (via Clerk) | None |

---

## 16. Audit log

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Full audit trail (who/what/when) per record | Yes | Recent-activity feed only | **P1** |
| Export audit log | Yes | None | **P2** |

---

## 17. Mobile

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Native iOS / Android app | Yes | None (responsive web only) | **P1** |
| Offline mode | Limited | None | **P2** |
| In-app barcode scanner using device camera | Yes | None | **P0** for any retail / warehouse use |

---

## 18. Barcode

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| Generate barcodes for items | Yes | None | **P1** |
| Print barcode labels | Yes | None | **P1** |
| USB scanner support (web) | Yes | Not configured (will work as keyboard input) | **P1** (UX polish) |
| Camera scanner (mobile / web) | Yes | None | **P0** for mobile |

---

## 19. Public API & webhooks

| Aspect | Zoho | Mystics today | Gap |
| --- | --- | --- | --- |
| OpenAPI-documented public REST API | Yes | Internal API exists, OpenAPI generated | **P1** (just needs API-key auth + docs) |
| API keys / OAuth for third-party apps | Yes | None | **P1** |
| Outbound webhooks (item.updated, order.created…) | Yes | None | **P1** |
| Rate limiting | Yes | None | **P2** |

---

# Consolidated prioritized backlog

## Must-have for Indian SMB parity (P0)

These are the gaps that, if not closed, will lose deals to Zoho /
TallyPrime / Vyapar in the SMB segment.

1. **GST-compliant invoice engine**
   - CGST / SGST / IGST split driven by place-of-supply
   - HSN summary block on invoice
   - Financial-year-aware invoice numbering series
   - Branded invoice PDF generation + email-to-customer
2. **E-invoicing (IRP → IRN + QR)** for orgs above the GST e-invoice
   threshold
3. **E-way bill generation** for goods movement above the state-specific
   threshold
4. **GST returns reports**: GSTR-1 (outward supplies), GSTR-3B
   summary, HSN-wise summary — exportable as JSON / Excel for filing
5. **Customer & supplier payments**
   - Record payment events linked to one or more invoices
   - Partial payments with allocation
   - Razorpay payment links on customer invoices
   - Outstanding balance auto-update
6. **Place-of-supply on customer record** (state field used to drive
   inter/intra-state tax split)
7. **Partial fulfilment of sales orders** (ship some lines now, the rest
   later)
8. **Partial receipt against purchase orders** (split shipments from
   supplier)
9. **Warehouse-to-warehouse stock transfer** as a first-class entity
   (transfer order with lifecycle + approval)
10. ~~**Item variants** (size / colour matrix under one parent product)~~ — shipped (Task #22)
11. **Composite items / bundles** with auto-decrement of components on
    sale
12. **Batch + expiry tracking** for items that need it (toggle per item)
13. **Shiprocket integration**: book shipment, store AWB on the sales
    order, fetch tracking, print label
14. **Tally export** (XML / Excel of vouchers) for accountant handoff
15. **Aging report** (receivables + payables buckets: 0-30, 31-60,
    61-90, 90+)
16. **Mobile camera barcode scanner** for picking and stock counting

## Important — expected by most SMBs (P1)

17. Email notifications (low stock, order confirmations, payment
    receipts)
18. Auto-reorder PO when on-hand < reorder level
19. Picklists and packing-slip PDFs
20. FIFO costing for inventory valuation
21. Negative-stock prevention toggle
22. Backorder tracking
23. Customer payment terms (Net 15 / Net 30) with due-date computation
24. Credit limit warnings on sales orders
25. Multiple item images via object storage
26. Separate barcode field (in addition to SKU)
27. WooCommerce + Amazon India multi-channel sync
28. Cross-channel reservation (don't oversell across Shopify + Amazon)
29. Audit log table covering create/update/delete on every business
    entity
30. Native iOS / Android app (or PWA install path)
31. Public API with API-key auth + outbound webhooks
32. Granular role permissions (per-module read/write)
33. Generic CSV voucher export (for non-Tally accountants)
34. P&L by item (margin)
35. Sales by customer / sales by channel reports

## Nice-to-have (P2)

36. Bin / shelf sub-locations inside a warehouse
37. Drop-ship (link SO line directly to PO)
38. Recurring sales orders / subscriptions
39. Customer & supplier self-service portal
40. Multi-currency with live FX
41. Reverse-charge (RCM) and composition-scheme invoice formats
42. Zoho Books / QuickBooks Online sync
43. Workflow rule builder (if X then Y)
44. Custom fields on items / orders / contacts
45. Scheduled email reports
46. Etsy / eBay / Shopee marketplace connectors
47. Live shipping rate-shopping at order time
48. Per-warehouse user permissions
49. Statement of accounts PDF for customers
50. Custom report builder

---

# Suggested phasing

A pragmatic v1 → v2 sequence for the next two quarters:

**Phase A — "GST + invoicing parity" (P0, 1-15)**

Deliver items 1, 4, 5, 6, 14, 15. After this phase Mystics is a
credible billing tool for an Indian SMB.

**Phase B — "Operations parity" (P0, 7-13, 16)**

Partial flow, transfers, variants, bundles, batch, Shiprocket, mobile
scanner. This is what makes Mystics more than a billing app.

**Phase C — "Compliance + scale" (P0, 2-3 + select P1)**

E-invoice, e-way bill, audit log, granular permissions, public API,
auto-reorder, email notifications. Targets the upper end of SMB.

**Phase D — Differentiators (P2)**

Pick 3-5 items from the P2 list based on early-customer feedback.
