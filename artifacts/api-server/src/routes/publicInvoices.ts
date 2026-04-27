import { Router, type IRouter } from "express";
import { loadInvoiceForOrder } from "../lib/invoiceData";
import { verifyInvoiceToken } from "../lib/invoiceLinks";

const router: IRouter = Router();

router.get("/public/invoices/:id.pdf", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const claims = verifyInvoiceToken(
      typeof req.query.org === "string" ? req.query.org : undefined,
      String(id),
      typeof req.query.exp === "string" ? req.query.exp : undefined,
      typeof req.query.token === "string" ? req.query.token : undefined,
    );
    if (!claims) {
      res.status(403).json({ error: "Invalid or expired invoice link." });
      return;
    }
    const result = await loadInvoiceForOrder(claims.organizationId, claims.salesOrderId);
    if ("notFound" in result || "wrongStatus" in result) {
      res.status(404).json({ error: "Invoice not available." });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="invoice-${result.orderNumber}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.setHeader("Content-Length", String(result.pdf.length));
    res.send(result.pdf);
  } catch (err) {
    next(err);
  }
});

export default router;
