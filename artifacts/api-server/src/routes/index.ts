import { Router, type IRouter } from "express";
import { clerkMiddleware } from "@clerk/express";
import healthRouter from "./health";
import razorpayWebhookRouter from "./razorpayWebhook";
import meRouter from "./me";
import organizationsRouter from "./organizations";
import warehousesRouter from "./warehouses";
import itemsRouter from "./items";
import stockMovementsRouter from "./stockMovements";
import customersRouter from "./customers";
import suppliersRouter from "./suppliers";
import salesOrdersRouter from "./salesOrders";
import customerPaymentsRouter from "./customerPayments";
import purchaseOrdersRouter from "./purchaseOrders";
import supplierPaymentsRouter from "./supplierPayments";
import dashboardRouter from "./dashboard";
import reportsRouter from "./reports";
import subscriptionRouter from "./subscription";
import shopifyRouter from "./shopify";
import shopifyWebhookRouter from "./shopifyWebhook";
import shopifyOauthCallbackRouter from "./shopifyOauthCallback";
import onboardingRouter from "./onboarding";
import teamRouter from "./team";

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

router.use(clerkMiddleware());

router.use(meRouter);
router.use(organizationsRouter);
router.use(warehousesRouter);
router.use(itemsRouter);
router.use(stockMovementsRouter);
router.use(customersRouter);
router.use(suppliersRouter);
router.use(salesOrdersRouter);
router.use(customerPaymentsRouter);
router.use(purchaseOrdersRouter);
router.use(supplierPaymentsRouter);
router.use(dashboardRouter);
router.use(reportsRouter);
router.use(subscriptionRouter);
router.use(onboardingRouter);
router.use(teamRouter);
router.use(shopifyRouter);

export default router;
