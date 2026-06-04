import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { Loader2 } from "lucide-react";
import { bulkEditItems, getListItemsQueryKey } from "@/lib/queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { CreatableCombobox } from "@/components/CreatableCombobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface BulkEditFormValues {
  category: string;
  taxRate: string;
  salePrice: string;
  reorderLevel: string;
  status: string;
}

interface BulkEditItemsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: number[];
  categoryOptions: string[];
  onSuccess: () => void;
}

export function BulkEditItemsDialog({
  open,
  onOpenChange,
  selectedIds,
  categoryOptions,
  onSuccess,
}: BulkEditItemsDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { register, handleSubmit, control, setError, reset, formState: { errors } } =
    useForm<BulkEditFormValues>({
      defaultValues: {
        category: "",
        taxRate: "",
        salePrice: "",
        reorderLevel: "",
        status: "",
      },
    });

  async function onSubmit(data: BulkEditFormValues) {
    const payload: Record<string, unknown> = { ids: selectedIds };
    let hasField = false;

    if (data.category !== "") {
      payload.category = data.category.trim() || null;
      hasField = true;
    }
    if (data.taxRate !== "") {
      const n = Number(data.taxRate);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        setError("taxRate", { message: "Must be between 0 and 100" });
        return;
      }
      payload.taxRate = n;
      hasField = true;
    }
    if (data.salePrice !== "") {
      const n = Number(data.salePrice);
      if (!Number.isFinite(n) || n < 0) {
        setError("salePrice", { message: "Must be non-negative" });
        return;
      }
      payload.salePrice = n;
      hasField = true;
    }
    if (data.reorderLevel !== "") {
      const n = Number(data.reorderLevel);
      if (!Number.isFinite(n) || n < 0) {
        setError("reorderLevel", { message: "Must be non-negative" });
        return;
      }
      payload.reorderLevel = n;
      hasField = true;
    }
    if (data.status && data.status !== "") {
      payload.status = data.status;
      hasField = true;
    }

    if (!hasField) {
      toast({
        title: "Nothing to update",
        description: "Fill in at least one field to apply changes.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await bulkEditItems(
        payload as unknown as Parameters<typeof bulkEditItems>[0],
      );
      toast({
        title: "Items updated",
        description: `${result.updated} item${result.updated === 1 ? "" : "s"} updated.`,
      });
      queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
      onSuccess();
      onOpenChange(false);
      reset();
    } catch (err) {
      toast({
        title: "Update failed",
        description:
          err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleClose() {
    if (isSubmitting) return;
    onOpenChange(false);
    reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => (v ? onOpenChange(true) : handleClose())}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Bulk edit {selectedIds.length} item
            {selectedIds.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Only fields you fill in will be updated. Leave a field blank to
            keep its current value unchanged.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Controller
              control={control}
              name="category"
              render={({ field }) => (
                <CreatableCombobox
                  value={field.value}
                  onChange={field.onChange}
                  options={categoryOptions}
                  placeholder="Leave blank to keep existing…"
                  searchPlaceholder="Search or create a category…"
                  emptyMessage="No categories yet."
                  testId="bulk-edit-category"
                />
              )}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bulk-edit-taxrate">GST Rate (%)</Label>
            <Input
              id="bulk-edit-taxrate"
              type="number"
              min={0}
              max={100}
              step="0.01"
              placeholder="Leave blank to keep existing"
              {...register("taxRate")}
              data-testid="bulk-edit-taxrate"
            />
            {errors.taxRate && (
              <p className="text-sm text-destructive">
                {errors.taxRate.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bulk-edit-saleprice">Selling Price (₹)</Label>
            <Input
              id="bulk-edit-saleprice"
              type="number"
              min={0}
              step="0.01"
              placeholder="Leave blank to keep existing"
              {...register("salePrice")}
              data-testid="bulk-edit-saleprice"
            />
            {errors.salePrice && (
              <p className="text-sm text-destructive">
                {errors.salePrice.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bulk-edit-reorderlevel">Min Stock Level</Label>
            <Input
              id="bulk-edit-reorderlevel"
              type="number"
              min={0}
              step="0.01"
              placeholder="Leave blank to keep existing"
              {...register("reorderLevel")}
              data-testid="bulk-edit-reorderlevel"
            />
            {errors.reorderLevel && (
              <p className="text-sm text-destructive">
                {errors.reorderLevel.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Status</Label>
            <Controller
              control={control}
              name="status"
              render={({ field }) => (
                <Select
                  value={field.value || "__keep__"}
                  onValueChange={(v) =>
                    field.onChange(v === "__keep__" ? "" : v)
                  }
                >
                  <SelectTrigger data-testid="bulk-edit-status">
                    <SelectValue placeholder="Leave blank to keep existing" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__keep__">Keep existing</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">
                      Inactive (archive)
                    </SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Update {selectedIds.length} item
              {selectedIds.length === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
