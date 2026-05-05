import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import emailSettingsRouter from "./emailSettings";
import razorpayWebhookRouter from "./razorpayWebhook";
import meRouter from "./me";
import organizationsRouter from "./organizations";
import warehousesRouter from "./warehouses";
import itemsRouter from "./items";
import stockMovementsRouter from "./stockMovements";
import customersRouter from "./customers";
import suppliersRouter from "./suppliers";
import salesOrdersRouter from "./salesOrders";
import shipmentsRouter from "./shipments";
import customerPaymentsRouter from "./customerPayments";
import paymentLinksRouter from "./paymentLinks";
import purchaseOrdersRouter from "./purchaseOrders";
import goodsReceiptsRouter from "./goodsReceipts";
import stockTransfersRouter from "./stockTransfers";
import jobWorkOrdersRouter from "./jobWorkOrders";
import supplierPaymentsRouter from "./supplierPayments";
import dashboardRouter from "./dashboard";
import reportsRouter from "./reports";
import subscriptionRouter from "./subscription";
import shopifyRouter from "./shopify";
import shopifyWebhookRouter from "./shopifyWebhook";
import shopifyOauthCallbackRouter from "./shopifyOauthCallback";
import shiprocketRouter from "./shiprocket";
import ewbRouter from "./ewb";
import einvoiceRouter from "./einvoice";
import storageRouter from "./storage";
import publicInvoicesRouter from "./publicInvoices";
import onboardingRouter from "./onboarding";
import teamRouter from "./team";
import adminRouter from "./admin";

const router: IRouter = Router();

// Public, unauthenticated routes — must be mounted before
// clerkMiddleware AND before any router that calls
// `router.use(tenantMiddleware)`, because such middleware fires for
// every request that enters that router (regardless of whether the
// path matches any of its routes).
router.use(healthRouter);
router.use(razorpayWebhookRouter);
router.use(shopifyWebhookRouter);
router.use(shopifyOauthCallbackRouter);
router.use(publicInvoicesRouter);

// Auth routes (signup, login, verify-email, forgot/reset-password) are
// public — they bootstrap the session that everything below requires.
router.use(authRouter);

router.use(meRouter);
router.use(emailSettingsRouter);
router.use(organizationsRouter);
router.use(warehousesRouter);
router.use(itemsRouter);
router.use(stockMovementsRouter);
router.use(customersRouter);
router.use(suppliersRouter);
router.use(salesOrdersRouter);
router.use(shipmentsRouter);
router.use(customerPaymentsRouter);
router.use(paymentLinksRouter);
router.use(purchaseOrdersRouter);
router.use(goodsReceiptsRouter);
router.use(stockTransfersRouter);
router.use(jobWorkOrdersRouter);
router.use(supplierPaymentsRouter);
router.use(dashboardRouter);
router.use(reportsRouter);
router.use(subscriptionRouter);
router.use(onboardingRouter);
router.use(teamRouter);
router.use(shopifyRouter);
router.use(shiprocketRouter);
router.use(ewbRouter);
router.use(einvoiceRouter);
router.use(storageRouter);
router.use(adminRouter);

export default router;
