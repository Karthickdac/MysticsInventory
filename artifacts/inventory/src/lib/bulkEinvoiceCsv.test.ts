import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import {
  BULK_EINVOICE_CSV_HEADERS,
  STATUS_LABEL,
  buildBatchCsv,
  extractIrnForRow,
  hasIrpAck,
} from "./bulkEinvoiceCsv";
import {
  BulkEinvoiceResultRowStatus,
  type BulkEinvoiceBatch,
  type BulkEinvoiceResultRow,
} from "@/lib/queryKeys";

// Build a minimally-valid result row, letting individual tests
// override only the fields under inspection. The defaults match
// the API contract: optional fields are explicitly `null` rather
// than missing, so we exercise the same shape the real bulk
// worker emits.
function row(overrides: Partial<BulkEinvoiceResultRow>): BulkEinvoiceResultRow {
  return {
    orderId: 1,
    orderNumber: "INV-0001",
    status: BulkEinvoiceResultRowStatus.success,
    message: null,
    errorCode: null,
    irn: null,
    ackNumber: null,
    ackDate: null,
    ...overrides,
  };
}

function batchOf(results: BulkEinvoiceResultRow[]): BulkEinvoiceBatch {
  return {
    id: "batch-1",
    status: "completed",
    createdAt: "2026-05-01T00:00:00.000Z",
    startedAt: "2026-05-01T00:00:00.000Z",
    completedAt: "2026-05-01T00:00:01.000Z",
    durationMs: 1000,
    ordersPerSecond: results.length,
    concurrency: 1,
    total: results.length,
    processed: results.length,
    succeeded: results.filter(
      (r) =>
        r.status === BulkEinvoiceResultRowStatus.success ||
        r.status === BulkEinvoiceResultRowStatus.already_issued,
    ).length,
    failed: results.filter(
      (r) => r.status === BulkEinvoiceResultRowStatus.failed,
    ).length,
    skipped: results.filter(
      (r) =>
        r.status === BulkEinvoiceResultRowStatus.skipped ||
        r.status === BulkEinvoiceResultRowStatus.ineligible,
    ).length,
    results,
  };
}

// Parse the CSV produced by buildBatchCsv into header + an array
// of objects keyed by header name. This lets the assertions read
// like contracts on each column rather than poking at raw string
// indices.
function parseCsv(csv: string): {
  header: string[];
  rows: Record<string, string>[];
} {
  const parsed = Papa.parse<string[]>(csv, {
    header: false,
    skipEmptyLines: false,
  });
  const all = parsed.data as string[][];
  const header = all[0] ?? [];
  const rows = all.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((name, idx) => {
      obj[name] = cells[idx] ?? "";
    });
    return obj;
  });
  return { header, rows };
}

describe("hasIrpAck", () => {
  it("returns true only for success and already_issued", () => {
    expect(hasIrpAck(BulkEinvoiceResultRowStatus.success)).toBe(true);
    expect(hasIrpAck(BulkEinvoiceResultRowStatus.already_issued)).toBe(true);
    expect(hasIrpAck(BulkEinvoiceResultRowStatus.failed)).toBe(false);
    expect(hasIrpAck(BulkEinvoiceResultRowStatus.skipped)).toBe(false);
    expect(hasIrpAck(BulkEinvoiceResultRowStatus.ineligible)).toBe(false);
    expect(hasIrpAck(BulkEinvoiceResultRowStatus.pending)).toBe(false);
    expect(hasIrpAck(BulkEinvoiceResultRowStatus.running)).toBe(false);
  });
});

describe("extractIrnForRow", () => {
  it("prefers the structured irn field when present", () => {
    const r = row({
      status: BulkEinvoiceResultRowStatus.success,
      irn: "IRN-STRUCTURED-123",
      message: "IRN IRN-FROM-MESSAGE",
    });
    expect(extractIrnForRow(r)).toBe("IRN-STRUCTURED-123");
  });

  it("falls back to parsing the success row message for legacy batches", () => {
    const r = row({
      status: BulkEinvoiceResultRowStatus.success,
      irn: null,
      message: "IRN LEGACY-IRN-456",
    });
    expect(extractIrnForRow(r)).toBe("LEGACY-IRN-456");
  });

  it("does not parse the message on already_issued without an irn field", () => {
    // already_issued rows historically carried a sentence message,
    // not "IRN <number>", so the parser fallback must not trigger.
    const r = row({
      status: BulkEinvoiceResultRowStatus.already_issued,
      irn: null,
      message: "IRN already exists for this order",
    });
    expect(extractIrnForRow(r)).toBe("");
  });

  it("returns empty string for non-IRN-bearing statuses", () => {
    expect(
      extractIrnForRow(
        row({
          status: BulkEinvoiceResultRowStatus.failed,
          irn: null,
          message: "Some error",
        }),
      ),
    ).toBe("");
    expect(
      extractIrnForRow(
        row({
          status: BulkEinvoiceResultRowStatus.skipped,
          irn: null,
          message: null,
        }),
      ),
    ).toBe("");
  });
});

describe("buildBatchCsv", () => {
  it("emits the documented header order", () => {
    const csv = buildBatchCsv(batchOf([]));
    const { header } = parseCsv(csv);
    expect(header).toEqual([
      "Order Number",
      "Status",
      "IRN",
      "Ack Number",
      "Ack Date",
      "Error Code",
      "Error Message",
    ]);
    // The exported tuple must stay in lock-step with the header
    // contract — accountants' downstream sheets bind to this order.
    expect(header).toEqual([...BULK_EINVOICE_CSV_HEADERS]);
  });

  it("populates IRN/Ack Number/Ack Date and clears the message on success rows", () => {
    const csv = buildBatchCsv(
      batchOf([
        row({
          orderId: 10,
          orderNumber: "INV-1010",
          status: BulkEinvoiceResultRowStatus.success,
          irn: "IRN-OK-1",
          ackNumber: "ACK-1",
          ackDate: "2026-05-01T10:15:00.000Z",
          // The success message is just "IRN <n>"; we already lift
          // it into the IRN column, so the Error Message column
          // must end up blank.
          message: "IRN IRN-OK-1",
        }),
      ]),
    );
    const { rows } = parseCsv(csv);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r["Order Number"]).toBe("INV-1010");
    expect(r["Status"]).toBe(STATUS_LABEL.success);
    expect(r["IRN"]).toBe("IRN-OK-1");
    expect(r["Ack Number"]).toBe("ACK-1");
    expect(r["Ack Date"]).toBe("2026-05-01T10:15:00.000Z");
    expect(r["Error Code"]).toBe("");
    expect(r["Error Message"]).toBe("");
  });

  it("populates IRN/Ack fields and clears the message on already_issued rows", () => {
    const csv = buildBatchCsv(
      batchOf([
        row({
          orderId: 11,
          orderNumber: "INV-1011",
          status: BulkEinvoiceResultRowStatus.already_issued,
          irn: "IRN-EXISTING-2",
          ackNumber: "ACK-2",
          ackDate: "2026-04-30T08:00:00.000Z",
          // already_issued historically carries a generic sentence;
          // it must be suppressed so accountants don't see noise in
          // the Error Message column.
          message: "An IRN already exists for this invoice",
        }),
      ]),
    );
    const r = parseCsv(csv).rows[0];
    expect(r["Status"]).toBe(STATUS_LABEL.already_issued);
    expect(r["IRN"]).toBe("IRN-EXISTING-2");
    expect(r["Ack Number"]).toBe("ACK-2");
    expect(r["Ack Date"]).toBe("2026-04-30T08:00:00.000Z");
    expect(r["Error Message"]).toBe("");
  });

  it("blanks IRN/Ack columns and keeps message + error code on failed rows", () => {
    const csv = buildBatchCsv(
      batchOf([
        row({
          orderId: 12,
          orderNumber: "INV-1012",
          status: BulkEinvoiceResultRowStatus.failed,
          irn: null,
          ackNumber: null,
          ackDate: null,
          errorCode: "RET194",
          message: "Buyer GSTIN is invalid",
        }),
      ]),
    );
    const r = parseCsv(csv).rows[0];
    expect(r["Status"]).toBe(STATUS_LABEL.failed);
    expect(r["IRN"]).toBe("");
    expect(r["Ack Number"]).toBe("");
    expect(r["Ack Date"]).toBe("");
    expect(r["Error Code"]).toBe("RET194");
    expect(r["Error Message"]).toBe("Buyer GSTIN is invalid");
  });

  it("suppresses stray ack values when the row status would not normally carry them", () => {
    // A defensive check: even if a row arrives in a non-IRP-ack
    // status with stale ackNumber/ackDate fields populated, the
    // CSV must still gate them off so accountants reconciling
    // against the portal don't see partial values.
    const csv = buildBatchCsv(
      batchOf([
        row({
          orderId: 13,
          orderNumber: "INV-1013",
          status: BulkEinvoiceResultRowStatus.failed,
          irn: "STALE-IRN",
          ackNumber: "STALE-ACK",
          ackDate: "2026-04-01T00:00:00.000Z",
          errorCode: "RET999",
          message: "Some failure",
        }),
      ]),
    );
    const r = parseCsv(csv).rows[0];
    expect(r["Ack Number"]).toBe("");
    expect(r["Ack Date"]).toBe("");
    // IRN column is intentionally not gated by status — the
    // structured field is still trustworthy when present — so we
    // assert it carries through. The ack-pair gating is the
    // contract under test here.
    expect(r["IRN"]).toBe("STALE-IRN");
  });

  it("keeps message + error code populated for ineligible/skipped rows", () => {
    const csv = buildBatchCsv(
      batchOf([
        row({
          orderId: 20,
          orderNumber: "INV-2020",
          status: BulkEinvoiceResultRowStatus.ineligible,
          message: "Order has no buyer GSTIN",
          errorCode: "INELIGIBLE_NO_GSTIN",
        }),
        row({
          orderId: 21,
          orderNumber: "INV-2021",
          status: BulkEinvoiceResultRowStatus.skipped,
          message: "Held by another in-flight attempt",
          errorCode: null,
        }),
      ]),
    );
    const rows = parseCsv(csv).rows;
    expect(rows[0]["Status"]).toBe(STATUS_LABEL.ineligible);
    expect(rows[0]["IRN"]).toBe("");
    expect(rows[0]["Ack Number"]).toBe("");
    expect(rows[0]["Ack Date"]).toBe("");
    expect(rows[0]["Error Code"]).toBe("INELIGIBLE_NO_GSTIN");
    expect(rows[0]["Error Message"]).toBe("Order has no buyer GSTIN");

    expect(rows[1]["Status"]).toBe(STATUS_LABEL.skipped);
    expect(rows[1]["IRN"]).toBe("");
    expect(rows[1]["Error Code"]).toBe("");
    expect(rows[1]["Error Message"]).toBe("Held by another in-flight attempt");
  });

  it("falls back to a #<orderId> label when orderNumber is missing", () => {
    const csv = buildBatchCsv(
      batchOf([
        row({
          orderId: 99,
          orderNumber: null,
          status: BulkEinvoiceResultRowStatus.pending,
          message: null,
        }),
      ]),
    );
    const r = parseCsv(csv).rows[0];
    expect(r["Order Number"]).toBe("#99");
    expect(r["Status"]).toBe(STATUS_LABEL.pending);
  });

  it("uses the legacy IRN-from-message fallback for success rows without a structured irn", () => {
    const csv = buildBatchCsv(
      batchOf([
        row({
          orderId: 30,
          orderNumber: "INV-3030",
          status: BulkEinvoiceResultRowStatus.success,
          irn: null,
          message: "IRN LEGACY-IRN-XYZ",
          ackNumber: "ACK-30",
          ackDate: "2026-05-01T11:00:00.000Z",
        }),
      ]),
    );
    const r = parseCsv(csv).rows[0];
    expect(r["IRN"]).toBe("LEGACY-IRN-XYZ");
    // Even though the message was the IRN-bearing legacy string,
    // it must still be suppressed in the Error Message column so
    // it doesn't double up against the lifted IRN value.
    expect(r["Error Message"]).toBe("");
    expect(r["Ack Number"]).toBe("ACK-30");
    expect(r["Ack Date"]).toBe("2026-05-01T11:00:00.000Z");
  });

  it("renders one CSV row per batch result, in order", () => {
    const csv = buildBatchCsv(
      batchOf([
        row({ orderId: 1, orderNumber: "A", status: BulkEinvoiceResultRowStatus.pending }),
        row({ orderId: 2, orderNumber: "B", status: BulkEinvoiceResultRowStatus.running }),
        row({
          orderId: 3,
          orderNumber: "C",
          status: BulkEinvoiceResultRowStatus.failed,
          message: "boom",
          errorCode: "X",
        }),
      ]),
    );
    const { rows } = parseCsv(csv);
    expect(rows.map((r) => r["Order Number"])).toEqual(["A", "B", "C"]);
    expect(rows.map((r) => r["Status"])).toEqual([
      STATUS_LABEL.pending,
      STATUS_LABEL.running,
      STATUS_LABEL.failed,
    ]);
  });
});
