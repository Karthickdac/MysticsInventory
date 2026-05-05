import { Link, useLocation } from "wouter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Settings, LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth";

function deriveInitials(name: string | null | undefined, email: string): string {
  if (name && name.trim().length > 0) {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
  }
  return email.charAt(0).toUpperCase();
}

export function UserMenu() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  if (!user) return null;
  const initials = deriveInitials(user.name, user.email);
  const handleSignOut = async () => {
    await logout();
    setLocation("/");
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="relative h-9 w-9 rounded-full"
          data-testid="btn-user-menu"
        >
          <Avatar className="h-9 w-9 border border-border">
            <AvatarFallback className="bg-primary/10 text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end" forceMount>
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p
              className="text-sm font-medium leading-none"
              data-testid="text-user-name"
            >
              {user.name ?? user.email}
            </p>
            <p
              className="text-xs leading-none text-muted-foreground"
              data-testid="text-user-email"
            >
              {user.email}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            href="/settings"
            className="cursor-pointer w-full flex items-center"
            data-testid="link-settings"
          >
            <Settings className="mr-2 h-4 w-4" />
            <span>Settings</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleSignOut}
          className="cursor-pointer text-red-600 focus:text-red-600 dark:text-red-400"
          data-testid="btn-sign-out"
        >
          <LogOut className="mr-2 h-4 w-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
