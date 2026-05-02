import Papa from "papaparse";
import {
  BulkEinvoiceResultRowStatus,
  type BulkEinvoiceBatch,
  type BulkEinvoiceResultRow,
} from "@/lib/queryKeys";

type RowStatus = BulkEinvoiceResultRow["status"];

export const STATUS_LABEL: Record<RowStatus, string> = {
  pending: "Queued",
  running: "Registering…",
  success: "IRN registered",
  already_issued: "Already registered",
  ineligible: "Skipped — not eligible",
  failed: "Failed",
  skipped: "Skipped",
};

export const BULK_EINVOICE_CSV_HEADERS = [
  "Order Number",
  "Status",
  "IRN",
  "Ack Number",
  "Ack Date",
  "Error Code",
  "Error Message",
] as const;

// Pull the IRN out of a result row for display in the dialog and
// the CSV. The bulk worker now ships an explicit `irn` field on
// success / already_issued rows, but we still fall back to parsing
// the success row's message ("IRN <number>") so this component
// keeps working against batches that were persisted before the
// API contract grew the structured field.
export function extractIrnForRow(row: BulkEinvoiceResultRow): string {
  if (row.irn) return row.irn;
  if (row.status === BulkEinvoiceResultRowStatus.success) {
    const m = row.message?.match(/^IRN\s+(\S+)/);
    return m?.[1] ?? "";
  }
  return "";
}

// Only `success` / `already_issued` rows carry an IRN, so the same
// gating applies to the IRP-issued ack number / ack date pair —
// every other status leaves them blank in the CSV.
export function hasIrpAck(status: RowStatus): boolean {
  return (
    status === BulkEinvoiceResultRowStatus.success ||
    status === BulkEinvoiceResultRowStatus.already_issued
  );
}

export function buildBatchCsv(batch: BulkEinvoiceBatch): string {
  return Papa.unparse(
    {
      fields: [...BULK_EINVOICE_CSV_HEADERS],
      data: batch.results.map((r) => {
        const irn = extractIrnForRow(r);
        // For success rows the message is just `IRN <number>`,
        // which we've already lifted into its own column. For
        // already_issued rows the message is a generic sentence
        // that adds nothing once the IRN itself is shown — drop
        // it from the CSV to keep accountants' Error Message
        // column reserved for actual error context.
        const messageForCsv =
          r.status === BulkEinvoiceResultRowStatus.success ||
          r.status === BulkEinvoiceResultRowStatus.already_issued
            ? ""
            : (r.message ?? "");
        // Keep ack fields aligned with the IRN column — populated
        // only on rows that actually picked up an IRP ack, blank
        // everywhere else so accountants reconciling against the
        // portal don't see stale or partial values.
        const ackNumber = hasIrpAck(r.status) ? (r.ackNumber ?? "") : "";
        const ackDate = hasIrpAck(r.status) ? (r.ackDate ?? "") : "";
        return [
          r.orderNumber ?? `#${r.orderId}`,
          STATUS_LABEL[r.status],
          irn,
          ackNumber,
          ackDate,
          r.errorCode ?? "",
          messageForCsv,
        ];
      }),
    },
    { quotes: true },
  );
}
