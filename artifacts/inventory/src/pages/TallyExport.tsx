import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Download } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  return {
    from: first.toISOString().slice(0, 10),
    to: last.toISOString().slice(0, 10),
  };
}

export default function TallyExport() {
  const initial = defaultRange();
  const [from, setFrom] = useState<string>(initial.from);
  const [to, setTo] = useState<string>(initial.to);
  const [include, setInclude] = useState({
    sales: true,
    receipts: true,
    purchases: true,
    payments: true,
  });

  const includeList = (Object.keys(include) as Array<keyof typeof include>)
    .filter((k) => include[k])
    .join(",");
  const enabled = from && to && from <= to && includeList.length > 0;
  const url = enabled
    ? `/api/reports/tally-export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&include=${encodeURIComponent(includeList)}`
    : "#";

  const toggle = (k: keyof typeof include) =>
    setInclude((prev) => ({ ...prev, [k]: !prev[k] }));

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/reports">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader
          title="Tally Export"
          description="Download a Tally-importable XML of vouchers in a date range."
          className="mb-0"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Date range</CardTitle>
          <CardDescription>
            All non-draft sales/purchase invoices and recorded payments within the range will be exported.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <Label htmlFor="tally-from">From</Label>
              <Input
                id="tally-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-44"
                data-testid="input-tally-from"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tally-to">To</Label>
              <Input
                id="tally-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-44"
                data-testid="input-tally-to"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Voucher types</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ["sales", "Sales (incl. credit notes for returns)"],
                ["receipts", "Customer receipts"],
                ["purchases", "Purchases"],
                ["payments", "Supplier payments"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={include[key]}
                  onCheckedChange={() => toggle(key)}
                  data-testid={`checkbox-tally-${key}`}
                />
                <span className="text-sm">{label}</span>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6 flex justify-end">
          <Button asChild disabled={!enabled} data-testid="button-tally-download">
            <a href={url} download>
              <Download className="mr-2 h-4 w-4" /> Download Tally XML
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
