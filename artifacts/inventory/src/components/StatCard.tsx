import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ReactNode } from "react";

interface StatCardProps {
  title: string;
  value: string | number;
  icon?: ReactNode;
  description?: string;
  trend?: {
    value: number;
    label: string;
  };
  className?: string;
}

export function StatCard({ title, value, icon, description, trend, className }: StatCardProps) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground" data-testid={`text-stat-title-${title.replace(/\s+/g, '-').toLowerCase()}`}>
          {title}
        </CardTitle>
        {icon && <div className="text-muted-foreground">{icon}</div>}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid={`text-stat-value-${title.replace(/\s+/g, '-').toLowerCase()}`}>
          {value}
        </div>
        {(description || trend) && (
          <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
            {trend && (
              <span
                className={cn(
                  "font-medium",
                  trend.value > 0 ? "text-green-600 dark:text-green-500" : trend.value < 0 ? "text-red-600 dark:text-red-500" : ""
                )}
              >
                {trend.value > 0 ? "+" : ""}
                {trend.value}%
              </span>
            )}
            {trend && trend.label && <span className="ml-1">{trend.label}</span>}
            {!trend && description && <span>{description}</span>}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
