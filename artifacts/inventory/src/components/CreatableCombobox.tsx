import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  allowCreate?: boolean;
  disabled?: boolean;
  className?: string;
  testId?: string;
};

export function CreatableCombobox({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No matches.",
  allowCreate = true,
  disabled,
  className,
  testId,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const sortedOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const opt of options) {
      const trimmed = opt.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }, [options]);

  const trimmedQuery = query.trim();
  const queryMatchesExisting =
    trimmedQuery.length > 0 &&
    sortedOptions.some((opt) => opt.toLowerCase() === trimmedQuery.toLowerCase());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          data-testid={testId}
          className={cn(
            "w-full justify-between font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        style={{ width: "var(--radix-popover-trigger-width)" }}
        align="start"
      >
        <Command shouldFilter>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {allowCreate && trimmedQuery
                ? `Press Enter to add "${trimmedQuery}"`
                : emptyMessage}
            </CommandEmpty>
            {sortedOptions.length > 0 && (
              <CommandGroup>
                {sortedOptions.map((opt) => (
                  <CommandItem
                    key={opt}
                    value={opt}
                    onSelect={() => {
                      onChange(opt);
                      setQuery("");
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value.toLowerCase() === opt.toLowerCase()
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                    {opt}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {allowCreate && trimmedQuery && !queryMatchesExisting && (
              <CommandGroup heading="Add new">
                <CommandItem
                  value={`__create__${trimmedQuery}`}
                  onSelect={() => {
                    onChange(trimmedQuery);
                    setQuery("");
                    setOpen(false);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add "{trimmedQuery}"
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
