import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useListItems,
  getListItemsQueryKey,
  useRegenerateItemBarcode,
  useAssignMissingItemBarcodes,
  downloadItemBarcodeLabelsPdf,
} from "@/lib/queryKeys";
import { Printer, RefreshCw, ScanLine, Sparkles } from "lucide-react";

type FilterMode = "all" | "missing" | "auto" | "manual";

export default function Barcodes() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [copies, setCopies] = useState<number>(1);

  const { data: items, isLoading } = useListItems({ excludeVariants: true });

  const filtered = useMemo(() => {
    const list = items ?? [];
    const q = search.trim().toLowerCase();
    return list.filter((i) => {
      // Variant parents have no physical stock and no barcode of their
      // own — hide them from this management screen.
      if (i.hasVariants) return false;
      if (filter === "missing" && i.barcode) return false;
      if (filter === "auto" && i.barcodeSource !== "auto") return false;
      if (filter === "manual" && i.barcodeSource !== "manual") return false;
      if (!q) return true;
      return (
        i.name.toLowerCase().includes(q) ||
        i.sku.toLowerCase().includes(q) ||
        (i.barcode ?? "").toLowerCase().includes(q)
      );
    });
  }, [items, search, filter]);

  const missingCount = useMemo(
    () => (items ?? []).filter((i) => !i.hasVariants && !i.barcode).length,
    [items],
  );

  const allSelected =
    filtered.length > 0 && filtered.every((i) => selected.has(i.id));

  const toggleAll = () => {
    if (allSelected) {
      const next = new Set(selected);
      for (const i of filtered) next.delete(i.id);
      setSelected(next);
    } else {
      const next = new Set(selected);
      for (const i of filtered) next.add(i.id);
      setSelected(next);
    }
  };

  const toggleOne = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const refreshList = () =>
    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });

  const regenerate = useRegenerateItemBarcode({
    mutation: {
      onSuccess: () => {
        toast({ title: "Barcode regenerated" });
        refreshList();
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not regenerate",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const assignMissing = useAssignMissingItemBarcodes({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: "Auto-barcodes assigned",
          description: `${data.assigned} of ${data.candidates} item(s) updated${
            data.failed > 0 ? `, ${data.failed} failed` : ""
          }.`,
        });
        refreshList();
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not assign barcodes",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const printSelected = async () => {
    if (selected.size === 0) {
      toast({
        title: "Nothing selected",
        description: "Pick at least one item to print labels for.",
      });
      return;
    }
    const ids = Array.from(selected);
    if (ids.length > 200) {
      toast({
        title: "Too many items",
        description: "Print up to 200 items per sheet.",
        variant: "destructive",
      });
      return;
    }
    // Items without a barcode can't render a Code 128 — surface that
    // up front rather than letting the server reject the whole batch.
    const withoutBarcode = (items ?? [])
      .filter((i) => ids.includes(i.id) && !i.barcode)
      .map((i) => i.sku);
    if (withoutBarcode.length > 0) {
      toast({
        title: "Some items have no barcode",
        description: `Assign or generate barcodes first: ${withoutBarcode
          .slice(0, 3)
          .join(", ")}${withoutBarcode.length > 3 ? "…" : ""}`,
        variant: "destructive",
      });
      return;
    }
    try {
      const blob = (await downloadItemBarcodeLabelsPdf({
        ids: ids.join(","),
        copies,
      })) as unknown as Blob;
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast({
        title: "Could not generate labels",
        description: e.response?.data?.error ?? "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Barcodes"
        description="Auto-generate, regenerate, and print Code 128 barcode labels for your items."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => assignMissing.mutate()}
              disabled={assignMissing.isPending || missingCount === 0}
              data-testid="btn-assign-missing-barcodes"
            >
              <Sparkles className="h-4 w-4 mr-2" />
              {assignMissing.isPending
                ? "Assigning…"
                : `Assign missing (${missingCount})`}
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScanLine className="h-5 w-5 text-primary" />
            Items
          </CardTitle>
          <CardDescription>
            Select items to bulk-print labels. Use the per-row Regenerate
            action to issue a fresh auto-barcode that replaces the
            current one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col md:flex-row gap-3 md:items-center">
            <Input
              placeholder="Search by name, SKU, or barcode…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="md:max-w-sm"
              data-testid="input-barcodes-search"
            />
            <Select
              value={filter}
              onValueChange={(v) => setFilter(v as FilterMode)}
            >
              <SelectTrigger
                className="md:w-44"
                data-testid="select-barcodes-filter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All items</SelectItem>
                <SelectItem value="missing">Missing barcode</SelectItem>
                <SelectItem value="auto">Auto-generated</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
              </SelectContent>
            </Select>
            <div className="md:ml-auto flex items-center gap-2">
              <label className="text-sm text-muted-foreground" htmlFor="copies">
                Copies
              </label>
              <Input
                id="copies"
                type="number"
                min={1}
                max={50}
                value={copies}
                onChange={(e) =>
                  setCopies(
                    Math.max(1, Math.min(50, Number(e.target.value) || 1)),
                  )
                }
                className="w-20"
                data-testid="input-barcodes-copies"
              />
              <Button
                onClick={printSelected}
                disabled={selected.size === 0}
                data-testid="btn-print-selected-barcodes"
              >
                <Printer className="h-4 w-4 mr-2" />
                Print {selected.size > 0 ? `(${selected.size})` : "selected"}
              </Button>
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-muted-foreground py-12 text-center">
              No items match the current filter.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleAll}
                      data-testid="checkbox-select-all-barcodes"
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Barcode</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((i) => (
                  <TableRow key={i.id} data-testid={`row-barcode-${i.id}`}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(i.id)}
                        onCheckedChange={() => toggleOne(i.id)}
                        data-testid={`checkbox-barcode-${i.id}`}
                        aria-label={`Select ${i.sku}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link
                        href={`/items/${i.id}`}
                        className="hover:underline"
                        data-testid={`link-barcode-item-${i.id}`}
                      >
                        {i.sku}
                      </Link>
                    </TableCell>
                    <TableCell>{i.name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {i.barcode ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {i.barcodeSource === "auto" ? (
                        <Badge variant="secondary">Auto</Badge>
                      ) : i.barcodeSource === "manual" ? (
                        <Badge variant="outline">Manual</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          None
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => regenerate.mutate({ id: i.id })}
                        disabled={regenerate.isPending}
                        data-testid={`btn-regenerate-barcode-${i.id}`}
                      >
                        <RefreshCw className="h-4 w-4 mr-1" />
                        {i.barcode ? "Regenerate" : "Generate"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
