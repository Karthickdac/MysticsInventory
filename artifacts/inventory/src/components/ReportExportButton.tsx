import { Download } from "lucide-react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

export type ExportColumn<T> = {
  header: string;
  accessor: (row: T) => string | number | null | undefined;
};

type Props<T> = {
  filename: string;
  title?: string;
  columns: ExportColumn<T>[];
  rows: T[];
  disabled?: boolean;
  meta?: { label: string; value: string }[];
};

function safeFilename(name: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = name
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${slug}-${stamp}`;
}

function rowsToMatrix<T>(columns: ExportColumn<T>[], rows: T[]) {
  const headers = columns.map((c) => c.header);
  const body = rows.map((row) =>
    columns.map((c) => {
      const v = c.accessor(row);
      if (v === null || v === undefined) return "";
      return v;
    }),
  );
  return { headers, body };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ReportExportButton<T>({
  filename,
  title,
  columns,
  rows,
  disabled,
  meta,
}: Props<T>) {
  const { toast } = useToast();
  const baseName = safeFilename(filename);
  const isEmpty = !rows || rows.length === 0;

  const exportCsv = () => {
    const { headers, body } = rowsToMatrix(columns, rows);
    const csv = Papa.unparse({ fields: headers, data: body });
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      `${baseName}.csv`,
    );
  };

  const exportExcel = () => {
    const { headers, body } = rowsToMatrix(columns, rows);
    const sheetData: (string | number)[][] = [];
    if (title) sheetData.push([title]);
    if (meta && meta.length > 0) {
      for (const m of meta) sheetData.push([`${m.label}: ${m.value}`]);
    }
    if (sheetData.length > 0) sheetData.push([]);
    sheetData.push(headers);
    for (const r of body) sheetData.push(r as (string | number)[]);

    const sheet = XLSX.utils.aoa_to_sheet(sheetData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Report");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    downloadBlob(
      new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      `${baseName}.xlsx`,
    );
  };

  const exportPdf = () => {
    const { headers, body } = rowsToMatrix(columns, rows);
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    let cursorY = 40;
    if (title) {
      doc.setFontSize(16);
      doc.text(title, 40, cursorY);
      cursorY += 18;
    }
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 40, cursorY);
    cursorY += 14;
    if (meta && meta.length > 0) {
      for (const m of meta) {
        doc.text(`${m.label}: ${m.value}`, 40, cursorY);
        cursorY += 12;
      }
    }
    cursorY += 4;
    autoTable(doc, {
      head: [headers],
      body: body.map((r) => r.map((cell) => String(cell ?? ""))),
      startY: cursorY,
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [40, 40, 40], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [248, 248, 248] },
      margin: { left: 40, right: 40 },
    });
    doc.save(`${baseName}.pdf`);
  };

  const onClick = (handler: () => void, label: string) => () => {
    if (isEmpty) {
      toast({
        title: "Nothing to export",
        description: "There are no rows to include in the export.",
        variant: "destructive",
      });
      return;
    }
    try {
      handler();
    } catch (err) {
      toast({
        title: `${label} export failed`,
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          data-testid="button-export-report"
        >
          <Download className="h-4 w-4 mr-2" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={onClick(exportPdf, "PDF")}
          data-testid="menu-export-pdf"
        >
          PDF
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onClick(exportExcel, "Excel")}
          data-testid="menu-export-excel"
        >
          Excel (.xlsx)
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onClick(exportCsv, "CSV")}
          data-testid="menu-export-csv"
        >
          CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
