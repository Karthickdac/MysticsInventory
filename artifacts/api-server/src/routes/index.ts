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
import purchaseOrdersRouter from "./purchaseOrders";
import dashboardRouter from "./dashboard";
import reportsRouter from "./reports";
import subscriptionRouter from "./subscription";
import shopifyRouter from "./shopify";
import onboardingRouter from "./onboarding";
import teamRouter from "./team";

const router: IRouter = Router();

router.use(healthRouter);
router.use(razorpayWebhookRouter);

router.use(clerkMiddleware());

router.use(meRouter);
router.use(organizationsRouter);
router.use(warehousesRouter);
router.use(itemsRouter);
router.use(stockMovementsRouter);
router.use(customersRouter);
router.use(suppliersRouter);
router.use(salesOrdersRouter);
router.use(purchaseOrdersRouter);
router.use(dashboardRouter);
router.use(reportsRouter);
router.use(subscriptionRouter);
router.use(shopifyRouter);
router.use(onboardingRouter);
router.use(teamRouter);

export default router;
