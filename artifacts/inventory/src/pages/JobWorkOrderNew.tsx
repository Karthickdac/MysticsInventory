import { PageHeader } from "@/components/PageHeader";
import {
  useCreateJobWorkOrder,
  useCreateSupplier,
  useListSuppliers,
  useListWarehouses,
  useListItems,
  useGetItem,
  getListJobWorkOrdersQueryKey,
  getGetItemQueryKey,
  getListSuppliersQueryKey,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Trash2, Plus, ArrowLeft, Sparkles, UserPlus } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { useEffect, useState } from "react";

const componentSchema = z.object({
  componentItemId: z.coerce.number().min(1, "Component required"),
  quantityPerOutput: z.coerce.number().gt(0, "Must be > 0"),
});

const schema = z
  .object({
    supplierId: z.coerce.number().min(1, "Job worker is required"),
    outputItemId: z.coerce.number().min(1, "Output item is required"),
    outputQuantity: z.coerce.number().gt(0, "Must be > 0"),
    sourceWarehouseId: z.coerce.number().min(1, "Source warehouse required"),
    destWarehouseId: z.coerce.number().min(1, "Destination warehouse required"),
    jobChargeRate: z.coerce.number().min(0).optional(),
    expectedReturnDate: z.string().optional(),
    notes: z.string().optional(),
    components: z
      .array(componentSchema)
      .min(1, "At least one component is required"),
  })
  .refine(
    (d) =>
      new Set(d.components.map((c) => c.componentItemId)).size ===
      d.components.length,
    {
      message: "Each component can only be listed once",
      path: ["components"],
    },
  );

type FormValues = z.infer<typeof schema>;

export default function JobWorkOrderNew() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: suppliers } = useListSuppliers();
  const { data: warehouses } = useListWarehouses();
  const { data: items } = useListItems({ leafOnly: true });
  const jobWorkers = (suppliers ?? []).filter((s) => s.isJobWorker);

  const createMutation = useCreateJobWorkOrder({
    mutation: {
      onSuccess: (detail) => {
        queryClient.invalidateQueries({
          queryKey: getListJobWorkOrdersQueryKey(),
        });
        toast({ title: "Job work order created" });
        setLocation(`/job-work/${detail.order.id}`);
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not create order",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      supplierId: 0,
      outputItemId: 0,
      outputQuantity: 1,
      sourceWarehouseId: 0,
      destWarehouseId: 0,
      jobChargeRate: 0,
      expectedReturnDate: format(new Date(), "yyyy-MM-dd"),
      notes: "",
      components: [{ componentItemId: 0, quantityPerOutput: 1 }],
    },
  });

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "components",
  });

  // Pre-fill BOM whenever the user picks an output item that is a bundle.
  const outputItemId = form.watch("outputItemId");
  const { data: outputItemDetail } = useGetItem(outputItemId, {
    query: {
      enabled: outputItemId > 0,
      queryKey: getGetItemQueryKey(outputItemId),
    },
  });

  useEffect(() => {
    if (!outputItemDetail) return;
    const bomComponents = outputItemDetail.components ?? [];
    if (bomComponents.length === 0) return;
    // Only pre-fill if the user hasn't entered a real component yet
    // (single empty default row).
    const current = form.getValues("components");
    const isEmpty =
      current.length === 0 ||
      (current.length === 1 && current[0].componentItemId === 0);
    if (!isEmpty) return;
    replace(
      bomComponents.map((c) => ({
        componentItemId: c.componentItemId,
        quantityPerOutput: Number(c.quantityPerBundle),
      })),
    );
  }, [outputItemDetail, replace, form]);

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({
      data: {
        supplierId: data.supplierId,
        outputItemId: data.outputItemId,
        outputQuantity: data.outputQuantity,
        sourceWarehouseId: data.sourceWarehouseId,
        destWarehouseId: data.destWarehouseId,
        jobChargeRate: data.jobChargeRate ?? 0,
        expectedReturnDate: data.expectedReturnDate || null,
        notes: data.notes || null,
        components: data.components,
      },
    });
  };

  const componentItems = (items ?? []).filter(
    (i) => !i.hasVariants && !i.isBundle,
  );
  const outputItems = items ?? [];

  const selectedWorkerId = form.watch("supplierId");
  const selectedWorker = jobWorkers.find((s) => s.id === Number(selectedWorkerId)) ?? null;

  // ── Inline "create job worker" dialog ─────────────────────────────
  // Lets the user add a new supplier-flagged-as-job-worker without
  // leaving this form. On success we refresh the suppliers list and
  // pre-select the newly created worker.
  const [workerDialogOpen, setWorkerDialogOpen] = useState(false);
  const [newWorker, setNewWorker] = useState({
    name: "",
    phone: "",
    email: "",
    gstNumber: "",
    address: "",
  });
  const createWorkerMutation = useCreateSupplier({
    mutation: {
      onSuccess: (created) => {
        queryClient.invalidateQueries({
          queryKey: getListSuppliersQueryKey(),
        });
        form.setValue("supplierId", created.id, { shouldValidate: true });
        setWorkerDialogOpen(false);
        setNewWorker({
          name: "",
          phone: "",
          email: "",
          gstNumber: "",
          address: "",
        });
        toast({ title: `Added ${created.name} as a job worker` });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not add job worker",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });
  const submitNewWorker = () => {
    if (!newWorker.name.trim()) {
      toast({
        title: "Name is required",
        variant: "destructive",
      });
      return;
    }
    createWorkerMutation.mutate({
      data: {
        name: newWorker.name.trim(),
        phone: newWorker.phone.trim() || undefined,
        email: newWorker.email.trim() || undefined,
        gstNumber: newWorker.gstNumber.trim() || undefined,
        address: newWorker.address.trim() || undefined,
        isJobWorker: true,
      },
    });
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/job-work">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader title="New Job Work Order" className="mb-0" />
      </div>

      {jobWorkers.length === 0 && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            You don't have any suppliers marked as job workers yet. Open the
            supplier you want to use, edit it, and turn on the &quot;Job
            worker&quot; flag to make it appear here.
          </CardContent>
        </Card>
      )}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="supplierId"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Job worker *</FormLabel>
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs"
                          onClick={() => setWorkerDialogOpen(true)}
                          data-testid="btn-add-job-worker-inline"
                        >
                          <UserPlus className="mr-1 h-3 w-3" />
                          Add new
                        </Button>
                      </div>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value ? field.value.toString() : ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-job-worker">
                            <SelectValue placeholder="Pick a job worker" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {jobWorkers.map((s) => (
                            <SelectItem key={s.id} value={s.id.toString()}>
                              {s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="outputItemId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Finished item *</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value ? field.value.toString() : ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-output-item">
                            <SelectValue placeholder="What is being made" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {outputItems.map((i) => (
                            <SelectItem key={i.id} value={i.id.toString()}>
                              {i.name}
                              {i.sku ? ` (${i.sku})` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="outputQuantity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Quantity to produce *</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          {...field}
                          data-testid="input-output-quantity"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="jobChargeRate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Job charge per unit (₹)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          {...field}
                          data-testid="input-job-charge-rate"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="sourceWarehouseId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Source warehouse *</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value ? field.value.toString() : ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-source-warehouse">
                            <SelectValue placeholder="Where to pull materials from" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {warehouses?.map((w) => (
                            <SelectItem key={w.id} value={w.id.toString()}>
                              {w.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="destWarehouseId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Destination warehouse *</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value ? field.value.toString() : ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-dest-warehouse">
                            <SelectValue placeholder="Where to receive finished goods" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {warehouses?.map((w) => (
                            <SelectItem key={w.id} value={w.id.toString()}>
                              {w.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="expectedReturnDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Expected return date</FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          {...field}
                          data-testid="input-expected-return"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          {selectedWorker && (
            <Card className="bg-muted/30">
              <CardContent className="pt-4 pb-4">
                <div className="text-xs uppercase text-muted-foreground tracking-wide mb-2">
                  Job worker info
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                  {selectedWorker.company && (
                    <div>
                      <span className="text-muted-foreground">Company: </span>
                      {selectedWorker.company}
                    </div>
                  )}
                  {selectedWorker.phone && (
                    <div>
                      <span className="text-muted-foreground">Phone: </span>
                      {selectedWorker.phone}
                    </div>
                  )}
                  {selectedWorker.email && (
                    <div>
                      <span className="text-muted-foreground">Email: </span>
                      {selectedWorker.email}
                    </div>
                  )}
                  {selectedWorker.gstNumber && (
                    <div>
                      <span className="text-muted-foreground">GST: </span>
                      {selectedWorker.gstNumber}
                    </div>
                  )}
                  {selectedWorker.address && (
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground">Address: </span>
                      <span className="whitespace-pre-wrap">{selectedWorker.address}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium text-lg">Raw materials</h3>
                {outputItemDetail && outputItemDetail.components.length > 0 && (
                  <span className="inline-flex items-center text-xs text-muted-foreground">
                    <Sparkles className="mr-1 h-3.5 w-3.5" />
                    Pre-filled from finished item BOM
                  </span>
                )}
              </div>

              <div className="space-y-4">
                {fields.map((field, index) => (
                  <div
                    key={field.id}
                    className="flex gap-3 items-start border p-4 rounded-lg bg-muted/20"
                  >
                    <div className="grid grid-cols-12 gap-3 w-full">
                      <div className="col-span-12 md:col-span-8">
                        <FormField
                          control={form.control}
                          name={`components.${index}.componentItemId`}
                          render={({ field: selectField }) => (
                            <FormItem>
                              <FormLabel className="text-xs">
                                Component
                              </FormLabel>
                              <Select
                                onValueChange={selectField.onChange}
                                value={
                                  selectField.value
                                    ? selectField.value.toString()
                                    : ""
                                }
                              >
                                <FormControl>
                                  <SelectTrigger
                                    data-testid={`select-component-${index}`}
                                  >
                                    <SelectValue placeholder="Pick a raw material" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {componentItems.map((i) => (
                                    <SelectItem
                                      key={i.id}
                                      value={i.id.toString()}
                                    >
                                      {i.name}
                                      {i.sku ? ` (${i.sku})` : ""}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      <div className="col-span-12 md:col-span-4">
                        <FormField
                          control={form.control}
                          name={`components.${index}.quantityPerOutput`}
                          render={({ field: inputField }) => (
                            <FormItem>
                              <FormLabel className="text-xs">
                                Qty per finished unit
                              </FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  step="0.001"
                                  min="0"
                                  {...inputField}
                                  data-testid={`input-component-qty-${index}`}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>
                    {fields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive h-9 w-9 mt-6"
                        onClick={() => remove(index)}
                        data-testid={`btn-remove-component-${index}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() =>
                  append({ componentItemId: 0, quantityPerOutput: 1 })
                }
                data-testid="btn-add-component"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add component
              </Button>

              <Separator className="my-6" />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        className="h-24"
                        placeholder="Process notes, quality requirements, lot details, etc."
                        data-testid="input-notes"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" asChild>
              <Link href="/job-work">Cancel</Link>
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending}
              data-testid="btn-submit-jwo"
            >
              {createMutation.isPending
                ? "Creating..."
                : "Create job work order"}
            </Button>
          </div>
        </form>
      </Form>

      <Dialog open={workerDialogOpen} onOpenChange={setWorkerDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a job worker</DialogTitle>
            <DialogDescription>
              Creates a supplier flagged as a job worker. Only the company
              name is required — you can fill the rest later from the
              supplier page.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="new-worker-name">Company Name *</Label>
              <Input
                id="new-worker-name"
                value={newWorker.name}
                onChange={(e) =>
                  setNewWorker({ ...newWorker, name: e.target.value })
                }
                placeholder="e.g. Sharma Tailoring Works"
                data-testid="input-new-worker-name"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="new-worker-phone">Phone Number</Label>
                <Input
                  id="new-worker-phone"
                  value={newWorker.phone}
                  onChange={(e) =>
                    setNewWorker({ ...newWorker, phone: e.target.value })
                  }
                  placeholder="Optional"
                  data-testid="input-new-worker-phone"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-worker-email">Email</Label>
                <Input
                  id="new-worker-email"
                  type="email"
                  value={newWorker.email}
                  onChange={(e) =>
                    setNewWorker({ ...newWorker, email: e.target.value })
                  }
                  placeholder="Optional"
                  data-testid="input-new-worker-email"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-worker-gst">GST Number</Label>
              <Input
                id="new-worker-gst"
                value={newWorker.gstNumber}
                onChange={(e) =>
                  setNewWorker({
                    ...newWorker,
                    gstNumber: e.target.value.toUpperCase(),
                  })
                }
                placeholder="Optional, e.g. 27ABCDE1234F1Z5"
                maxLength={15}
                data-testid="input-new-worker-gst"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-worker-address">Address</Label>
              <Textarea
                id="new-worker-address"
                value={newWorker.address}
                onChange={(e) =>
                  setNewWorker({ ...newWorker, address: e.target.value })
                }
                placeholder="Optional"
                rows={3}
                data-testid="input-new-worker-address"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setWorkerDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitNewWorker}
              disabled={createWorkerMutation.isPending}
              data-testid="btn-save-new-worker"
            >
              {createWorkerMutation.isPending ? "Adding..." : "Add worker"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
