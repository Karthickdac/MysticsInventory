import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusType = "draft" | "confirmed" | "ordered" | "shipped" | "partially_shipped" | "partially_received" | "delivered" | "cancelled" | "refunded" | "received" | "billed" | "paid" | "active" | "inactive" | "pending" | "returned" | "invoiced";

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const normalizedStatus = status.toLowerCase() as StatusType;
  
  let variant: "default" | "secondary" | "destructive" | "outline" = "outline";
  let colorClass = "";

  switch (normalizedStatus) {
    case "confirmed":
    case "shipped":
    case "received":
    case "delivered":
    case "active":
      variant = "default";
      colorClass = "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 border-green-200 dark:border-green-800/30";
      break;
    case "draft":
    case "pending":
      variant = "secondary";
      colorClass = "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400 hover:bg-yellow-100 dark:hover:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800/30";
      break;
    case "partially_shipped":
      variant = "secondary";
      colorClass = "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 border-blue-200 dark:border-blue-800/30";
      break;
    case "partially_received":
      variant = "secondary";
      colorClass = "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/30 border-purple-200 dark:border-purple-800/30";
      break;
    case "refunded":
    case "returned":
      variant = "secondary";
      colorClass = "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-900/30 border-orange-200 dark:border-orange-800/30";
      break;
    case "cancelled":
    case "inactive":
      variant = "destructive";
      break;
    default:
      variant = "outline";
  }

  return (
    <Badge 
      variant={variant} 
      className={cn("capitalize font-medium", colorClass, className)}
      data-testid={`badge-status-${normalizedStatus}`}
    >
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
