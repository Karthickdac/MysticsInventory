import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scriptUrl = new URL(
  "../../scripts/check-org-scope.mjs",
  import.meta.url,
).href;
const mod = (await import(scriptUrl)) as {
  __testOnly: {
    ORG_ID_PREDICATE_RE: RegExp;
    stripSqlComments: (text: string) => string;
    rawSqlHasOrgIdPredicate: (text: string) => boolean;
    rawSqlMentionsOrgScopedTable: (
      text: string,
      sqlNames: Iterable<string>,
    ) => string | null;
    checkFile: (
      filePath: string,
      orgScoped: { identNames: Set<string>; sqlNames: Set<string> },
    ) => Array<{
      file: string;
      line: number;
      column: number;
      op: string;
      table: string;
      reason: string;
    }>;
    discoverOrgScopedTables: () => Promise<{
      identNames: Set<string>;
      sqlNames: Set<string>;
    }>;
  };
};

const {
  stripSqlComments,
  rawSqlHasOrgIdPredicate,
  rawSqlMentionsOrgScopedTable,
  checkFile,
  discoverOrgScopedTables,
} = mod.__testOnly;

let orgScoped: { identNames: Set<string>; sqlNames: Set<string> };

beforeAll(async () => {
  orgScoped = await discoverOrgScopedTables();
  // Sanity guard: if schema discovery breaks, fail loudly here rather
  // than letting later assertions silently pass on empty sets.
  if (orgScoped.identNames.size === 0 || orgScoped.sqlNames.size === 0) {
    throw new Error("schema discovery returned no org-scoped tables");
  }
  for (const required of ["suppliers", "customers"]) {
    if (!orgScoped.sqlNames.has(required)) {
      throw new Error(
        `expected fixture table "${required}" to be discovered as org-scoped`,
      );
    }
  }
});

describe("stripSqlComments", () => {
  it("removes line comments", () => {
    const out = stripSqlComments("SELECT 1 -- hello\nFROM t");
    expect(out).not.toContain("hello");
    expect(out).toContain("SELECT 1");
    expect(out).toContain("FROM t");
  });
  it("removes block comments", () => {
    expect(stripSqlComments("SELECT 1 /* hi */ FROM t")).toBe(
      "SELECT 1   FROM t",
    );
  });
  it("does not touch string literals it shouldn't (best-effort)", () => {
    // The stripper is a heuristic; document the limitation.
    expect(stripSqlComments("SELECT 'x'")).toBe("SELECT 'x'");
  });
});

describe("rawSqlHasOrgIdPredicate", () => {
  it("accepts WHERE organization_id = …", () => {
    expect(
      rawSqlHasOrgIdPredicate("SELECT * FROM suppliers WHERE organization_id = $1"),
    ).toBe(true);
  });
  it("accepts JOIN ON … organization_id …", () => {
    expect(
      rawSqlHasOrgIdPredicate(
        "SELECT s.* FROM suppliers s JOIN customers c ON c.organization_id = s.organization_id WHERE c.id = $1",
      ),
    ).toBe(true);
  });
  it("accepts case-insensitive WHERE / column name", () => {
    expect(
      rawSqlHasOrgIdPredicate("select * from suppliers where Organization_Id = $1"),
    ).toBe(true);
  });
  it("rejects mention-only in SELECT list (no WHERE)", () => {
    expect(
      rawSqlHasOrgIdPredicate("SELECT organization_id, name FROM suppliers"),
    ).toBe(false);
  });
  it("rejects UPDATE … SET organization_id = X without a WHERE", () => {
    expect(
      rawSqlHasOrgIdPredicate(
        "UPDATE suppliers SET organization_id = 1, name = 'x'",
      ),
    ).toBe(false);
  });
  it("rejects INSERT column list mention", () => {
    expect(
      rawSqlHasOrgIdPredicate(
        "INSERT INTO suppliers (organization_id, name) VALUES ($1, $2)",
      ),
    ).toBe(false);
  });
  it("rejects an `organization_id` mention that lives only in a comment", () => {
    expect(
      rawSqlHasOrgIdPredicate(
        "UPDATE suppliers SET name = 'x' WHERE id = $1 -- organization_id is implicit",
      ),
    ).toBe(false);
    expect(
      rawSqlHasOrgIdPredicate(
        "UPDATE suppliers SET name = 'x' WHERE id = $1 /* organization_id implicit */",
      ),
    ).toBe(false);
  });
  it("rejects `organization_id` appearing only before the WHERE", () => {
    // SET clause mentions organization_id, WHERE only filters by id —
    // not tenant-scoped, must be flagged.
    expect(
      rawSqlHasOrgIdPredicate(
        "UPDATE suppliers SET organization_id = $1 WHERE id = $2",
      ),
    ).toBe(false);
  });
});

describe("rawSqlMentionsOrgScopedTable", () => {
  it("detects exact word-boundary matches", () => {
    expect(
      rawSqlMentionsOrgScopedTable("SELECT * FROM suppliers", new Set(["suppliers"])),
    ).toBe("suppliers");
  });
  it("does not flag a table name appearing as a substring of an unrelated identifier", () => {
    expect(
      rawSqlMentionsOrgScopedTable(
        "SELECT * FROM suppliers_archive",
        new Set(["suppliers"]),
      ),
    ).toBeNull();
  });
  it("ignores matches that live only inside a comment", () => {
    expect(
      rawSqlMentionsOrgScopedTable(
        "SELECT 1 -- once joined suppliers here",
        new Set(["suppliers"]),
      ),
    ).toBeNull();
  });
});

// Fixture-based integration tests. We materialise tiny .ts files in a
// tmp directory and run the real `checkFile` against them so the AST
// walker, allow-comment lookup, and raw-SQL predicate check are all
// exercised end-to-end.
describe("checkFile (fixtures)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "check-org-scope-"));
  });

  function fixture(name: string, src: string): string {
    const p = path.join(tmpDir, name);
    writeFileSync(p, src);
    return p;
  }

  function run(src: string): Array<{ op: string; table: string; reason: string }> {
    const file = fixture(`f-${Math.random().toString(36).slice(2)}.ts`, src);
    try {
      return checkFile(file, orgScoped).map(({ op, table, reason }) => ({
        op,
        table,
        reason,
      }));
    } finally {
      rmSync(file, { force: true });
    }
  }

  // ── Drizzle query-builder ──
  it("flags `db.select().from(orgTable)` without a where", () => {
    const v = run(`
      import { db } from "@workspace/db";
      import { suppliersTable } from "@workspace/db";
      export async function leak() {
        return db.select().from(suppliersTable);
      }
    `);
    expect(v).toHaveLength(1);
    expect(v[0].op).toBe("from");
  });

  it("passes `db.select().from(orgTable).where(eq(orgTable.organizationId, …))`", () => {
    const v = run(`
      import { db, suppliersTable } from "@workspace/db";
      import { eq } from "drizzle-orm";
      export async function ok(orgId: number) {
        return db.select().from(suppliersTable).where(eq(suppliersTable.organizationId, orgId));
      }
    `);
    expect(v).toHaveLength(0);
  });

  it("passes `.where(and(eq(orgTable.organizationId, …), …))`", () => {
    const v = run(`
      import { db, suppliersTable } from "@workspace/db";
      import { eq, and } from "drizzle-orm";
      export async function ok(orgId: number, id: number) {
        return db
          .select()
          .from(suppliersTable)
          .where(and(eq(suppliersTable.id, id), eq(suppliersTable.organizationId, orgId)));
      }
    `);
    expect(v).toHaveLength(0);
  });

  it("flags `.where(...)` that is present but omits the org predicate", () => {
    const v = run(`
      import { db, suppliersTable } from "@workspace/db";
      import { eq, and } from "drizzle-orm";
      export async function leak(id: number) {
        return db
          .select()
          .from(suppliersTable)
          .where(and(eq(suppliersTable.id, id)));
      }
    `);
    expect(v).toHaveLength(1);
    expect(v[0].op).toBe("from");
    expect(v[0].reason).toMatch(/organizationId/);
  });

  it("respects a `// org-scope-allow:` comment on a Drizzle query", () => {
    const v = run(`
      import { db, suppliersTable } from "@workspace/db";
      export async function bootstrap() {
        // org-scope-allow: super-admin dashboard, intentionally cross-tenant
        return db.select().from(suppliersTable);
      }
    `);
    expect(v).toHaveLength(0);
  });

  it("does NOT respect an allow comment placed AFTER the offending line", () => {
    const v = run(`
      import { db, suppliersTable } from "@workspace/db";
      export async function leak() {
        return db.select().from(suppliersTable);
        // org-scope-allow: too late — comment is below the call
      }
    `);
    expect(v).toHaveLength(1);
    expect(v[0].op).toBe("from");
  });

  // ── db.query relational API ──
  it("flags `db.query.<orgTable>.findMany(...)` without where.organizationId", () => {
    const v = run(`
      import { db } from "@workspace/db";
      export async function leak() {
        return db.query.suppliersTable.findMany({ where: (s, { eq }) => eq(s.id, 1) });
      }
    `);
    expect(v).toHaveLength(1);
    expect(v[0].op).toBe("findMany");
  });

  it("passes `db.query.<orgTable>.findFirst` whose where mentions .organizationId", () => {
    const v = run(`
      import { db } from "@workspace/db";
      export async function ok(orgId: number) {
        return db.query.suppliersTable.findFirst({
          where: (s, { eq, and }) => and(eq(s.organizationId, orgId), eq(s.id, 1)),
        });
      }
    `);
    expect(v).toHaveLength(0);
  });

  // ── Raw SQL via .execute(sql\`…\`) ──
  it("flags raw SELECT that references an org-scoped table without WHERE", () => {
    const v = run(`
      import { db, sql } from "@workspace/db";
      export async function leak() {
        return db.execute(sql\`SELECT id, organization_id FROM suppliers\`);
      }
    `);
    expect(v).toHaveLength(1);
    expect(v[0].op).toBe("execute");
    expect(v[0].table).toBe("suppliers");
  });

  it("flags raw UPDATE without a WHERE clause", () => {
    const v = run(`
      import { db, sql } from "@workspace/db";
      export async function leak() {
        return db.execute(sql\`UPDATE suppliers SET organization_id = 1, name = 'x'\`);
      }
    `);
    expect(v).toHaveLength(1);
    expect(v[0].op).toBe("execute");
  });

  it("flags raw DELETE without a WHERE clause", () => {
    const v = run(`
      import { db, sql } from "@workspace/db";
      export async function leak() {
        return db.execute(sql\`DELETE FROM customers\`);
      }
    `);
    expect(v).toHaveLength(1);
    expect(v[0].op).toBe("execute");
    expect(v[0].table).toBe("customers");
  });

  it("passes raw SQL with `WHERE organization_id = …`", () => {
    const v = run(`
      import { db, sql } from "@workspace/db";
      export async function ok(orgId: number) {
        return db.execute(sql\`UPDATE suppliers SET name = 'x' WHERE id = 1 AND organization_id = \${orgId}\`);
      }
    `);
    expect(v).toHaveLength(0);
  });

  it("passes raw JOIN with `ON c.organization_id = s.organization_id`", () => {
    const v = run(`
      import { db, sql } from "@workspace/db";
      export async function ok() {
        return db.execute(sql\`
          SELECT s.* FROM suppliers s
          JOIN customers c ON c.organization_id = s.organization_id
          WHERE c.id = 1
        \`);
      }
    `);
    expect(v).toHaveLength(0);
  });

  it("respects `// org-scope-allow:` on a raw SQL execute call", () => {
    const v = run(`
      import { db, sql } from "@workspace/db";
      export async function ok() {
        // org-scope-allow: lookup by globally unique batch UUID
        return db.execute(sql\`UPDATE suppliers SET name = 'x' WHERE batch_uuid = 'abc'\`);
      }
    `);
    expect(v).toHaveLength(0);
  });

  it("does not flag raw SQL touching a non-org-scoped table", () => {
    const v = run(`
      import { db, sql } from "@workspace/db";
      export async function ok() {
        return db.execute(sql\`SELECT id FROM organizations WHERE id = 1\`);
      }
    `);
    expect(v).toHaveLength(0);
  });

  it("does not satisfy the predicate via an in-comment `organization_id` mention", () => {
    const v = run(`
      import { db, sql } from "@workspace/db";
      export async function leak() {
        return db.execute(sql\`UPDATE suppliers SET name = 'x' WHERE id = 1 -- organization_id implied\`);
      }
    `);
    expect(v).toHaveLength(1);
    expect(v[0].op).toBe("execute");
  });
});
