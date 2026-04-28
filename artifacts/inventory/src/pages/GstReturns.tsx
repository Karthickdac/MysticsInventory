import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Download, FileJson } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useGetGstr1Report,
  useGetGstr3bReport,
  useGetHsnSummaryReport,
} from "@/lib/queryKeys";
import { formatCurrency } from "@/lib/format";

// All defaults below are computed against Asia/Kolkata wall time
// (IST = UTC+5:30, no DST) so a user opening this page at 11:30pm UTC
// on the 31st sees the IST month they actually live in.
function nowInIst(): { y: number; m: number } {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  const d = new Date(istMs);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

function defaultPeriod(): string {
  // Default to the previous calendar month — that's the period that's
  // typically open for filing right after a month rolls over.
  const { y, m } = nowInIst();
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

// Quarters anchor on the FY start year (Q1 = Apr-Jun of that year).
// Default selection picks the most-recently-completed quarter so the
// user lands on a period that's actually file-able.
function defaultQuarter(): { fyStart: number; q: 1 | 2 | 3 | 4 } {
  const { y, m } = nowInIst();
  if (m >= 1 && m <= 3) {
    // Jan-Mar ⇒ FY started last April; last completed quarter is Q3 (Oct-Dec).
    return { fyStart: y - 1, q: 3 };
  }
  if (m >= 4 && m <= 6) {
    // Apr-Jun ⇒ last completed = previous FY's Q4 (Jan-Mar of this year).
    return { fyStart: y - 1, q: 4 };
  }
  if (m >= 7 && m <= 9) {
    // Jul-Sep ⇒ Q1 of current FY (Apr-Jun) just closed.
    return { fyStart: y, q: 1 };
  }
  // Oct-Dec ⇒ Q2 of current FY (Jul-Sep) just closed.
  return { fyStart: y, q: 2 };
}

function downloadUrl(report: "gstr-1" | "gstr-3b" | "hsn-summary", period: string, format: "csv" | "gstn"): string {
  return `/api/reports/${report}?period=${encodeURIComponent(period)}&format=${format}`;
}

export default function GstReturns() {
  const [mode, setMode] = useState<"month" | "quarter">("month");
  const [monthPeriod, setMonthPeriod] = useState<string>(defaultPeriod());
  const initialQ = defaultQuarter();
  const [quarterFy, setQuarterFy] = useState<number>(initialQ.fyStart);
  const [quarterN, setQuarterN] = useState<1 | 2 | 3 | 4>(initialQ.q);
  const composedPeriod =
    mode === "month" ? monthPeriod : `${quarterFy}-Q${quarterN}`;
  const [activePeriod, setActivePeriod] = useState<string>(composedPeriod);

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/reports">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader
          title="GST Returns"
          description="Preview GSTR-1, GSTR-3B and HSN summary, then download for filing."
          className="mb-0"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filing period</CardTitle>
          <CardDescription>
            Choose a month (regular filers) or a quarter (QRMP filers). Asia/Kolkata calendar. GSTN JSON downloads work with the offline tool; CSV is for spreadsheet review.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={mode} onValueChange={(v) => setMode(v as "month" | "quarter")}>
            <TabsList>
              <TabsTrigger value="month" data-testid="tab-period-month">Month</TabsTrigger>
              <TabsTrigger value="quarter" data-testid="tab-period-quarter">Quarter</TabsTrigger>
            </TabsList>
            <TabsContent value="month" className="pt-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="gst-period">Period (YYYY-MM)</Label>
                  <Input
                    id="gst-period"
                    type="month"
                    value={monthPeriod}
                    onChange={(e) => setMonthPeriod(e.target.value)}
                    className="w-44"
                    data-testid="input-gst-period"
                  />
                </div>
                <Button
                  onClick={() => setActivePeriod(monthPeriod)}
                  data-testid="button-load-gst"
                >
                  Load
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="quarter" className="pt-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="gst-quarter-fy">Financial year (start)</Label>
                  <Input
                    id="gst-quarter-fy"
                    type="number"
                    min={2017}
                    max={2099}
                    value={quarterFy}
                    onChange={(e) => setQuarterFy(Number(e.target.value) || quarterFy)}
                    className="w-32"
                    data-testid="input-gst-quarter-fy"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="gst-quarter-n">Quarter</Label>
                  <select
                    id="gst-quarter-n"
                    value={quarterN}
                    onChange={(e) => setQuarterN(Number(e.target.value) as 1 | 2 | 3 | 4)}
                    className="h-9 w-44 rounded-md border border-input bg-background px-3 text-sm"
                    data-testid="select-gst-quarter-n"
                  >
                    <option value={1}>Q1 (Apr–Jun)</option>
                    <option value={2}>Q2 (Jul–Sep)</option>
                    <option value={3}>Q3 (Oct–Dec)</option>
                    <option value={4}>Q4 (Jan–Mar)</option>
                  </select>
                </div>
                <Button
                  onClick={() => setActivePeriod(`${quarterFy}-Q${quarterN}`)}
                  data-testid="button-load-gst-quarter"
                >
                  Load
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Tabs defaultValue="gstr1" className="space-y-4">
        <TabsList>
          <TabsTrigger value="gstr1">GSTR-1</TabsTrigger>
          <TabsTrigger value="gstr3b">GSTR-3B</TabsTrigger>
          <TabsTrigger value="hsn">HSN Summary</TabsTrigger>
        </TabsList>

        <TabsContent value="gstr1">
          <Gstr1Section period={activePeriod} />
        </TabsContent>
        <TabsContent value="gstr3b">
          <Gstr3bSection period={activePeriod} />
        </TabsContent>
        <TabsContent value="hsn">
          <HsnSection period={activePeriod} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DownloadButtons({
  report,
  period,
}: {
  report: "gstr-1" | "gstr-3b" | "hsn-summary";
  period: string;
}) {
  return (
    <div className="flex gap-2">
      <Button asChild variant="outline" size="sm">
        <a
          href={downloadUrl(report, period, "csv")}
          download
          data-testid={`download-${report}-csv`}
        >
          <Download className="mr-2 h-4 w-4" /> CSV
        </a>
      </Button>
      <Button asChild variant="outline" size="sm">
        <a
          href={downloadUrl(report, period, "gstn")}
          download
          data-testid={`download-${report}-gstn`}
        >
          <FileJson className="mr-2 h-4 w-4" /> GSTN JSON
        </a>
      </Button>
    </div>
  );
}

function Gstr1Section({ period }: { period: string }) {
  const { data, isLoading, isError, error } = useGetGstr1Report({ period });

  if (isError) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load GSTR-1."}
        </CardContent>
      </Card>
    );
  }
  if (isLoading || !data) {
    return <Skeleton className="h-40 w-full" />;
  }
  const r = data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Totals — {r.period.period} (FY {r.period.fyLabel})</CardTitle>
            <CardDescription>
              {r.totals.invoiceCount} invoices · taxable {formatCurrency(r.totals.taxableValue)} · tax {formatCurrency(r.totals.igst + r.totals.cgst + r.totals.sgst)}
            </CardDescription>
          </div>
          <DownloadButtons report="gstr-1" period={period} />
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">B2B (registered buyers)</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Buyer</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead>POS</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">Tax</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.b2b.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="h-20 text-center text-muted-foreground">No B2B invoices.</TableCell></TableRow>
              ) : r.b2b.map((row, i) => (
                <TableRow key={`${row.invoiceNumber}-${row.rate}-${i}`}>
                  <TableCell className="font-medium">{row.invoiceNumber}</TableCell>
                  <TableCell>{row.invoiceDate}</TableCell>
                  <TableCell>{row.buyerName}</TableCell>
                  <TableCell className="font-mono text-xs">{row.buyerGstin}</TableCell>
                  <TableCell>{row.placeOfSupply}</TableCell>
                  <TableCell className="text-right">{row.rate}%</TableCell>
                  <TableCell className="text-right">{formatCurrency(row.taxableValue)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(row.igst + row.cgst + row.sgst)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">B2C-Large (inter-state, &gt; ₹2.5L)</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>POS</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">IGST</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.b2cLarge.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-20 text-center text-muted-foreground">No B2C-Large invoices.</TableCell></TableRow>
              ) : r.b2cLarge.map((row, i) => (
                <TableRow key={`${row.invoiceNumber}-${row.rate}-${i}`}>
                  <TableCell className="font-medium">{row.invoiceNumber}</TableCell>
                  <TableCell>{row.invoiceDate}</TableCell>
                  <TableCell>{row.placeOfSupply}</TableCell>
                  <TableCell className="text-right">{row.rate}%</TableCell>
                  <TableCell className="text-right">{formatCurrency(row.taxableValue)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(row.igst)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">B2C-Small (rate-wise summary)</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>POS</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">IGST</TableHead>
                <TableHead className="text-right">CGST</TableHead>
                <TableHead className="text-right">SGST</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.b2cSmall.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-20 text-center text-muted-foreground">No B2C-Small entries.</TableCell></TableRow>
              ) : r.b2cSmall.map((row, i) => (
                <TableRow key={`${row.placeOfSupply}-${row.rate}-${i}`}>
                  <TableCell>{row.placeOfSupply}</TableCell>
                  <TableCell className="text-right">{row.rate}%</TableCell>
                  <TableCell className="text-right">{formatCurrency(row.taxableValue)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(row.igst)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(row.cgst)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(row.sgst)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credit Notes (returned orders)</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Note #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Buyer</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">Tax</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.creditNotes.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-20 text-center text-muted-foreground">No credit notes.</TableCell></TableRow>
              ) : r.creditNotes.map((row, i) => (
                <TableRow key={`${row.noteNumber}-${row.rate}-${i}`}>
                  <TableCell className="font-medium">{row.noteNumber}</TableCell>
                  <TableCell>{row.noteDate}</TableCell>
                  <TableCell>{row.buyerName}</TableCell>
                  <TableCell className="text-right">{row.rate}%</TableCell>
                  <TableCell className="text-right">{formatCurrency(row.taxableValue)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(row.igst + row.cgst + row.sgst)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Gstr3bSection({ period }: { period: string }) {
  const { data, isLoading, isError, error } = useGetGstr3bReport({ period });
  if (isError) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load GSTR-3B."}
        </CardContent>
      </Card>
    );
  }
  if (isLoading || !data) return <Skeleton className="h-40 w-full" />;
  const r = data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>GSTR-3B — {r.period.period}</CardTitle>
            <CardDescription>
              Total taxable supplies {formatCurrency(r.totals.totalTaxableSupplies)} · total tax {formatCurrency(r.totals.totalTax)}
            </CardDescription>
          </div>
          <DownloadButtons report="gstr-3b" period={period} />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Section</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">IGST</TableHead>
                <TableHead className="text-right">CGST</TableHead>
                <TableHead className="text-right">SGST</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>3.1(a)</TableCell>
                <TableCell>Outward taxable supplies</TableCell>
                <TableCell className="text-right">{formatCurrency(r.outwardTaxable.taxableValue)}</TableCell>
                <TableCell className="text-right">{formatCurrency(r.outwardTaxable.igst)}</TableCell>
                <TableCell className="text-right">{formatCurrency(r.outwardTaxable.cgst)}</TableCell>
                <TableCell className="text-right">{formatCurrency(r.outwardTaxable.sgst)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>3.1(c)</TableCell>
                <TableCell>Other outward (Nil/Exempt)</TableCell>
                <TableCell className="text-right">{formatCurrency(r.outwardNilExempt.taxableValue)}</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right">—</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>4(A)</TableCell>
                <TableCell>ITC available (purchase tax not yet tracked)</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right">{formatCurrency(r.itc.igst)}</TableCell>
                <TableCell className="text-right">{formatCurrency(r.itc.cgst)}</TableCell>
                <TableCell className="text-right">{formatCurrency(r.itc.sgst)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function HsnSection({ period }: { period: string }) {
  const { data, isLoading, isError, error } = useGetHsnSummaryReport({ period });
  if (isError) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load HSN summary."}
        </CardContent>
      </Card>
    );
  }
  if (isLoading || !data) return <Skeleton className="h-40 w-full" />;
  const r = data;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>HSN summary — {r.period.period}</CardTitle>
          <CardDescription>
            Total taxable {formatCurrency(r.totals.taxableValue)} · total invoice value {formatCurrency(r.totals.totalValue)}
          </CardDescription>
        </div>
        <DownloadButtons report="hsn-summary" period={period} />
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>HSN</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>UQC</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Taxable</TableHead>
              <TableHead className="text-right">IGST</TableHead>
              <TableHead className="text-right">CGST</TableHead>
              <TableHead className="text-right">SGST</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.rows.length === 0 ? (
              <TableRow><TableCell colSpan={10} className="h-24 text-center text-muted-foreground">No invoices in this period.</TableCell></TableRow>
            ) : r.rows.map((row, i) => (
              <TableRow key={`${row.hsnCode}-${row.rate}-${row.unit}-${i}`}>
                <TableCell className="font-mono text-xs">{row.hsnCode}</TableCell>
                <TableCell>{row.description}</TableCell>
                <TableCell>{row.unit}</TableCell>
                <TableCell className="text-right">{row.totalQuantity}</TableCell>
                <TableCell className="text-right">{row.rate}%</TableCell>
                <TableCell className="text-right">{formatCurrency(row.taxableValue)}</TableCell>
                <TableCell className="text-right">{formatCurrency(row.igst)}</TableCell>
                <TableCell className="text-right">{formatCurrency(row.cgst)}</TableCell>
                <TableCell className="text-right">{formatCurrency(row.sgst)}</TableCell>
                <TableCell className="text-right font-medium">{formatCurrency(row.totalValue)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
