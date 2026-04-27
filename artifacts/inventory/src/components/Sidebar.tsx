import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { 
  LayoutDashboard, 
  Package, 
  Users, 
  Truck, 
  Warehouse, 
  ArrowLeftRight, 
  ShoppingCart, 
  ShoppingBag, 
  BarChart3, 
  Blocks,
  Settings
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

interface SidebarProps {
  className?: string;
  onNavigate?: () => void;
}

export function Sidebar({ className, onNavigate }: SidebarProps) {
  const [location] = useLocation();
  
  // wouter location does not include basePath
  const isActive = (path: string) => {
    if (path === '/dashboard' && location === '/dashboard') return true;
    if (path !== '/dashboard' && location.startsWith(path)) return true;
    return false;
  };

  const navItems = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { name: "Items", href: "/items", icon: Package },
    { name: "Stock Movements", href: "/stock", icon: ArrowLeftRight },
    { name: "Warehouses", href: "/warehouses", icon: Warehouse },
    { name: "Sales Orders", href: "/sales-orders", icon: ShoppingCart },
    { name: "Purchase Orders", href: "/purchase-orders", icon: ShoppingBag },
    { name: "Customers", href: "/customers", icon: Users },
    { name: "Suppliers", href: "/suppliers", icon: Truck },
    { name: "Reports", href: "/reports", icon: BarChart3 },
    { name: "Integrations", href: "/integrations", icon: Blocks },
    { name: "Settings", href: "/settings", icon: Settings },
  ];

  return (
    <div className={cn("flex h-full flex-col bg-sidebar border-r border-sidebar-border", className)}>
      <div className="flex h-14 items-center border-b border-sidebar-border px-4 shrink-0">
        <Link href="/dashboard" className="flex items-center gap-2 font-bold text-sidebar-foreground">
          <div className="bg-primary/10 p-1.5 rounded-md">
            <Package className="h-5 w-5 text-primary" />
          </div>
          <span className="text-lg tracking-tight">Mystics Inv</span>
        </Link>
      </div>
      
      <ScrollArea className="flex-1 py-4">
        <nav className="grid gap-1 px-2">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link 
                key={item.name} 
                href={item.href}
                onClick={onNavigate}
                data-testid={`link-nav-${item.name.toLowerCase().replace(/\s+/g, '-')}`}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active 
                    ? "bg-sidebar-accent text-sidebar-accent-foreground" 
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
              >
                <item.icon className={cn("h-4 w-4", active ? "text-primary" : "text-muted-foreground")} />
                {item.name}
              </Link>
            );
          })}
        </nav>
      </ScrollArea>
    </div>
  );
}
