// Shared `@workspace/db` and `drizzle-orm` mocks for vitest.
//
// Usage in a test file:
//   vi.mock("@workspace/db", () => createDbModuleMock());
//   vi.mock("drizzle-orm", () => drizzleOrmMock);
//
// To add a new table sentinel, append one line to the object returned
// by `createDbModuleMock`: `myNewTable: tableSentinel("my_new_table"),`.
// To add a new drizzle expression helper, add a one-liner to
// `drizzleOrmMock`. Both are opaque pass-throughs the mock db never
// inspects.

import { dbMock } from "./dbMock";

function tableSentinel(name: string): Record<string, unknown> {
  return new Proxy(
    { __table: name },
    {
      get: (target, prop) => {
        if (prop in target)
          return (target as Record<string, unknown>)[prop as string];
        return { __table: name, __column: String(prop) };
      },
    },
  );
}

export function createDbModuleMock() {
  return {
    db: {
      select: (..._args: unknown[]) => dbMock.select(),
      update: (..._args: unknown[]) => dbMock.update(),
      insert: (..._args: unknown[]) => dbMock.insert(),
      delete: (..._args: unknown[]) => dbMock.delete(),
      execute: (...args: unknown[]) => dbMock.execute(...args),
    },
    organizationsTable: tableSentinel("organizations"),
    organizationMembersTable: tableSentinel("organization_members"),
    salesOrdersTable: tableSentinel("sales_orders"),
    salesOrderLinesTable: tableSentinel("sales_order_lines"),
    customersTable: tableSentinel("customers"),
    itemsTable: tableSentinel("items"),
    einvoiceBulkBatchesTable: tableSentinel("einvoice_bulk_batches"),
    usersTable: tableSentinel("users"),
    warehousesTable: tableSentinel("warehouses"),
    suppliersTable: tableSentinel("suppliers"),
  };
}

export const drizzleOrmMock = {
  eq: (...args: unknown[]) => ({ kind: "eq", args }),
  and: (...args: unknown[]) => ({ kind: "and", args }),
  or: (...args: unknown[]) => ({ kind: "or", args }),
  inArray: (...args: unknown[]) => ({ kind: "inArray", args }),
  isNull: (...args: unknown[]) => ({ kind: "isNull", args }),
  lt: (...args: unknown[]) => ({ kind: "lt", args }),
  // Tagged-template form only. Add `.raw`/`.identifier` if needed.
  sql: (...args: unknown[]) => ({ kind: "sql", args }),
};
