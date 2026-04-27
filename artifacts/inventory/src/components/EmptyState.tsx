import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div 
      className={cn(
        "flex flex-col items-center justify-center p-8 text-center bg-card rounded-xl border border-dashed border-border min-h-[300px]", 
        className
      )}
      data-testid="empty-state"
    >
      {icon && (
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-muted text-muted-foreground mb-4">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold text-foreground" data-testid="text-empty-title">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-sm mt-2 mb-6" data-testid="text-empty-description">
        {description}
      </p>
      {action && <div>{action}</div>}
    </div>
  );
}
