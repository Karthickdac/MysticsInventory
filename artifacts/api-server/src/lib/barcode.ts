import bwipjs from "bwip-js/node";

export interface BarcodeRenderOptions {
  scale?: number;
  height?: number;
  includetext?: boolean;
  textsize?: number;
  paddingwidth?: number;
  paddingheight?: number;
}

/**
 * Render a Code128 barcode as a PNG buffer. Code128 is the right pick
 * for retail SKUs / internal codes — it accepts the full ASCII range
 * (so any SKU works) and 1D scanners read it reliably without an
 * EAN/UPC checksum dance.
 */
export async function renderBarcodePng(
  value: string,
  opts: BarcodeRenderOptions = {},
): Promise<Buffer> {
  return bwipjs.toBuffer({
    bcid: "code128",
    text: value,
    scale: opts.scale ?? 3,
    height: opts.height ?? 14,
    includetext: opts.includetext ?? true,
    textxalign: "center",
    textsize: opts.textsize ?? 10,
    paddingwidth: opts.paddingwidth ?? 4,
    paddingheight: opts.paddingheight ?? 4,
    backgroundcolor: "FFFFFF",
  });
}

/**
 * Pick what to actually encode on a label. Items can have an optional
 * dedicated `barcode` (e.g. an EAN scanned in from a vendor label);
 * when absent we fall back to the human-readable SKU so every product
 * is printable without extra setup.
 */
export function resolveBarcodeValue(item: {
  barcode: string | null | undefined;
  sku: string;
}): string {
  const b = item.barcode?.trim();
  return b && b.length > 0 ? b : item.sku;
}
