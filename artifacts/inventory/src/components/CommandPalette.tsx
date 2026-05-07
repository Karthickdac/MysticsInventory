import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Package,
  Users,
  Truck,
  ShoppingCart,
  ShoppingBag,
  LayoutDashboard,
  Loader2,
  Warehouse,
  BarChart3,
  Blocks,
  Settings,
  UserCog,
  ArrowLeftRight,
  Clock,
  Plus,
  type LucideIcon,
} from "lucide-react";
import {
  useRecentRecords,
  type RecentRecordKind,
} from "@/lib/recentRecords";
import {
  useListItems,
  useListCustomers,
  useListSuppliers,
  useListSalesOrders,
  useListPurchaseOrders,
  getListItemsQueryKey,
  getListCustomersQueryKey,
  getListSuppliersQueryKey,
  getListSalesOrdersQueryKey,
  getListPurchaseOrdersQueryKey,
} from "@workspace/api-client-react";

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  openPalette: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error("useCommandPalette must be used within <CommandPaletteProvider>");
  }
  return ctx;
}

const NAV_SHORTCUTS: Array<{
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  keywords?: string[];
}> = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, keywords: ["home", "overview"] },
  { label: "Items", href: "/items", icon: Package, keywords: ["products", "sku", "inventory"] },
  { label: "Stock Movements", href: "/stock", icon: ArrowLeftRight, keywords: ["transfers", "ledger"] },
  { label: "Warehouses", href: "/warehouses", icon: Warehouse },
  { label: "Sales Orders", href: "/sales-orders", icon: ShoppingCart, keywords: ["so", "invoices"] },
  { label: "Customers", href: "/customers", icon: Users },
  { label: "Purchase Orders", href: "/purchase-orders", icon: ShoppingBag, keywords: ["po", "bills"] },
  { label: "Suppliers", href: "/suppliers", icon: Truck, keywords: ["vendors"] },
  { label: "Reports", href: "/reports", icon: BarChart3, keywords: ["analytics", "insights"] },
  { label: "Team", href: "/team", icon: UserCog, keywords: ["users", "members", "invite"] },
  { label: "Integrations", href: "/integrations", icon: Blocks, keywords: ["shopify", "connect"] },
  { label: "Settings", href: "/settings", icon: Settings, keywords: ["preferences", "organization"] },
];

const RESULT_LIMIT = 6;

const RECENT_KIND_ICON: Record<RecentRecordKind, LucideIcon> = {
  item: Package,
  customer: Users,
  supplier: Truck,
  sales_order: ShoppingCart,
  purchase_order: ShoppingBag,
};

const QUICK_CREATE_ACTIONS: Array<{
  label: string;
  href: string;
  icon: LucideIcon;
  testId: string;
  keywords?: string[];
}> = [
  {
    label: "New item",
    href: "/items?new=1",
    icon: Package,
    testId: "cmdk-create-item",
    keywords: ["create", "add", "product", "sku"],
  },
  {
    label: "New sales order",
    href: "/sales-orders/new",
    icon: ShoppingCart,
    testId: "cmdk-create-sales-order",
    keywords: ["create", "add", "so", "invoice"],
  },
  {
    label: "New purchase order",
    href: "/purchase-orders/new",
    icon: ShoppingBag,
    testId: "cmdk-create-purchase-order",
    keywords: ["create", "add", "po", "bill"],
  },
  {
    label: "New customer",
    href: "/customers?new=1",
    icon: Users,
    testId: "cmdk-create-customer",
    keywords: ["create", "add", "client"],
  },
  {
    label: "New supplier",
    href: "/suppliers?new=1",
    icon: Truck,
    testId: "cmdk-create-supplier",
    keywords: ["create", "add", "vendor"],
  },
];

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function CommandPaletteContent({ onClose }: { onClose: () => void }) {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 150);
  const hasQuery = debounced.length > 0;
  const recentRecords = useRecentRecords();

  // Server-side filtered for high-cardinality lists
  const itemParams = hasQuery ? { search: debounced } : undefined;
  const itemsQuery = useListItems(itemParams, {
    query: { enabled: hasQuery, queryKey: getListItemsQueryKey(itemParams) },
  });
  const customerParams = hasQuery ? { search: debounced } : undefined;
  const customersQuery = useListCustomers(customerParams, {
    query: {
      enabled: hasQuery,
      queryKey: getListCustomersQueryKey(customerParams),
    },
  });
  const supplierParams = hasQuery ? { search: debounced } : undefined;
  const suppliersQuery = useListSuppliers(supplierParams, {
    query: {
      enabled: hasQuery,
      queryKey: getListSuppliersQueryKey(supplierParams),
    },
  });

  // SO/PO list endpoints don't accept a search param — fetch a small recent
  // window only when the user is actively searching, and filter client-side.
  const salesOrdersQuery = useListSalesOrders(undefined, {
    query: { enabled: hasQuery, queryKey: getListSalesOrdersQueryKey() },
  });
  const purchaseOrdersQuery = useListPurchaseOrders(undefined, {
    query: { enabled: hasQuery, queryKey: getListPurchaseOrdersQueryKey() },
  });

  const items = useMemo(
    () => (itemsQuery.data ?? []).slice(0, RESULT_LIMIT),
    [itemsQuery.data],
  );
  const customers = useMemo(
    () => (customersQuery.data ?? []).slice(0, RESULT_LIMIT),
    [customersQuery.data],
  );
  const suppliers = useMemo(
    () => (suppliersQuery.data ?? []).slice(0, RESULT_LIMIT),
    [suppliersQuery.data],
  );
  const salesOrders = useMemo(() => {
    const q = debounced.toLowerCase();
    return (salesOrdersQuery.data ?? [])
      .filter(
        (so) =>
          so.orderNumber.toLowerCase().includes(q) ||
          so.customerName.toLowerCase().includes(q),
      )
      .slice(0, RESULT_LIMIT);
  }, [salesOrdersQuery.data, debounced]);
  const purchaseOrders = useMemo(() => {
    const q = debounced.toLowerCase();
    return (purchaseOrdersQuery.data ?? [])
      .filter(
        (po) =>
          po.orderNumber.toLowerCase().includes(q) ||
          po.supplierName.toLowerCase().includes(q),
      )
      .slice(0, RESULT_LIMIT);
  }, [purchaseOrdersQuery.data, debounced]);

  const isFetching =
    hasQuery &&
    (itemsQuery.isFetching ||
      customersQuery.isFetching ||
      suppliersQuery.isFetching ||
      salesOrdersQuery.isFetching ||
      purchaseOrdersQuery.isFetching);

  const navigate = useCallback(
    (path: string) => {
      onClose();
      // Defer navigation a tick so the dialog close animation doesn't
      // fight the route change for focus.
      setTimeout(() => setLocation(path), 0);
    },
    [onClose, setLocation],
  );

  return (
    <>
      <CommandInput
        placeholder="Search items, customers, orders... or jump to a page"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {isFetching ? (
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching...
            </span>
          ) : hasQuery ? (
            "No matches found."
          ) : (
            "Start typing to search across your workspace."
          )}
        </CommandEmpty>

        {!hasQuery && recentRecords.length > 0 && (
          <>
            <CommandGroup heading="Recent">
              {recentRecords.map((record) => {
                const Icon = RECENT_KIND_ICON[record.kind];
                return (
                  <CommandItem
                    key={`recent-${record.kind}-${record.id}`}
                    value={`recent ${record.title} ${record.subtitle ?? ""}`}
                    onSelect={() => navigate(record.href)}
                    data-testid={`cmdk-recent-${record.kind}-${record.id}`}
                  >
                    <Icon className="text-muted-foreground" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate">{record.title}</span>
                      {record.subtitle && (
                        <span className="text-xs text-muted-foreground truncate">
                          {record.subtitle}
                        </span>
                      )}
                    </div>
                    <Clock className="ml-auto h-3 w-3 text-muted-foreground/60" />
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {!hasQuery && (
          <>
            <CommandGroup heading="Create">
              {QUICK_CREATE_ACTIONS.map((action) => (
                <CommandItem
                  key={action.href}
                  value={`create ${action.label} ${(action.keywords ?? []).join(" ")}`}
                  onSelect={() => navigate(action.href)}
                  data-testid={action.testId}
                >
                  <action.icon className="text-muted-foreground" />
                  <span>{action.label}</span>
                  <Plus className="ml-auto h-3 w-3 text-muted-foreground/60" />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {hasQuery && items.length > 0 && (
          <CommandGroup heading="Items">
            {items.map((item) => (
              <CommandItem
                key={`item-${item.id}`}
                value={`item ${item.sku} ${item.name}`}
                onSelect={() => navigate(`/items/${item.id}`)}
                data-testid={`cmdk-item-item-${item.id}`}
              >
                <Package className="text-muted-foreground" />
                <div className="flex flex-col min-w-0">
                  <span className="truncate">{item.name}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    SKU {item.sku}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {hasQuery && customers.length > 0 && (
          <CommandGroup heading="Customers">
            {customers.map((customer) => (
              <CommandItem
                key={`customer-${customer.id}`}
                value={`customer ${customer.name} ${customer.email ?? ""} ${customer.company ?? ""}`}
                onSelect={() => navigate(`/customers?focus=${customer.id}`)}
                data-testid={`cmdk-item-customer-${customer.id}`}
              >
                <Users className="text-muted-foreground" />
                <div className="flex flex-col min-w-0">
                  <span className="truncate">{customer.name}</span>
                  {customer.company && (
                    <span className="text-xs text-muted-foreground truncate">
                      {customer.company}
                    </span>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {hasQuery && suppliers.length > 0 && (
          <CommandGroup heading="Suppliers">
            {suppliers.map((supplier) => (
              <CommandItem
                key={`supplier-${supplier.id}`}
                value={`supplier ${supplier.name} ${supplier.email ?? ""} ${supplier.company ?? ""}`}
                onSelect={() => navigate(`/suppliers?focus=${supplier.id}`)}
                data-testid={`cmdk-item-supplier-${supplier.id}`}
              >
                <Truck className="text-muted-foreground" />
                <div className="flex flex-col min-w-0">
                  <span className="truncate">{supplier.name}</span>
                  {supplier.company && (
                    <span className="text-xs text-muted-foreground truncate">
                      {supplier.company}
                    </span>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {hasQuery && salesOrders.length > 0 && (
          <CommandGroup heading="Sales Orders">
            {salesOrders.map((so) => (
              <CommandItem
                key={`so-${so.id}`}
                value={`so ${so.orderNumber} ${so.customerName}`}
                onSelect={() => navigate(`/sales-orders/${so.id}`)}
                data-testid={`cmdk-item-so-${so.id}`}
              >
                <ShoppingCart className="text-muted-foreground" />
                <div className="flex flex-col min-w-0">
                  <span className="truncate">{so.orderNumber}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {so.customerName}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {hasQuery && purchaseOrders.length > 0 && (
          <CommandGroup heading="Purchase Orders">
            {purchaseOrders.map((po) => (
              <CommandItem
                key={`po-${po.id}`}
                value={`po ${po.orderNumber} ${po.supplierName}`}
                onSelect={() => navigate(`/purchase-orders/${po.id}`)}
                data-testid={`cmdk-item-po-${po.id}`}
              >
                <ShoppingBag className="text-muted-foreground" />
                <div className="flex flex-col min-w-0">
                  <span className="truncate">{po.orderNumber}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {po.supplierName}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {hasQuery && (items.length > 0 || customers.length > 0 || suppliers.length > 0 || salesOrders.length > 0 || purchaseOrders.length > 0) && (
          <CommandSeparator />
        )}

        <CommandGroup heading="Jump to">
          {NAV_SHORTCUTS.map((nav) => (
            <CommandItem
              key={nav.href}
              value={`nav ${nav.label} ${(nav.keywords ?? []).join(" ")}`}
              onSelect={() => navigate(nav.href)}
              data-testid={`cmdk-nav-${nav.href.replace(/\//g, "-")}`}
            >
              <nav.icon className="text-muted-foreground" />
              <span>{nav.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </>
  );
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const openPalette = useCallback(() => setOpen(true), []);

  // Global ⌘K / Ctrl+K hotkey. We intentionally allow it from inside
  // form inputs (industry convention — Linear / Slack / Notion all do
  // this) but bail out if any extra modifier is held to avoid stomping
  // on browser shortcuts like Cmd+Shift+K (web inspector) or Cmd+Alt+K.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "k" && e.key !== "K") return;
      const isCommand = e.metaKey || e.ctrlKey;
      if (!isCommand) return;
      if (e.shiftKey || e.altKey) return;
      if (e.defaultPrevented) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const value = useMemo<CommandPaletteContextValue>(
    () => ({ open, setOpen, openPalette }),
    [open, openPalette],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandPaletteContent onClose={() => setOpen(false)} />
      </CommandDialog>
    </CommandPaletteContext.Provider>
  );
}
