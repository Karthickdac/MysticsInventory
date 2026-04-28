import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Plus,
  Truck,
  XCircle,
} from "lucide-react";
import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  useGenerateSalesOrderEwb,
  useUpdateSalesOrderEwbVehicle,
  useCancelSalesOrderEwb,
  useGetEwbConnection,
  useGetEwbReferenceData,
  getGetSalesOrderQueryKey,
  type EwbDetails,
} from "@/lib/queryKeys";

interface EwbPanelProps {
  orderId: number;
  orderNumber: string;
  orderStatus: string;
  ewb: EwbDetails | null | undefined;
}

const TRANSPORT_MODE_LABELS: Record<string, string> = {
  "1": "Road",
  "2": "Rail",
  "3": "Air",
  "4": "Ship",
};

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  return format(new Date(value), "MMM d, h:mm a");
}

function isOrderEwbEligible(status: string): boolean {
  return [
    "confirmed",
    "shipped",
    "partially_shipped",
    "delivered",
    "invoiced",
    "paid",
  ].includes(status);
}

export function EwbPanel({
  orderId,
  orderNumber,
  orderStatus,
  ewb,
}: EwbPanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const connectionQuery = useGetEwbConnection();
  const refQuery = useGetEwbReferenceData();
  const [generateOpen, setGenerateOpen] = useState(false);
  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getGetSalesOrderQueryKey(orderId),
    });
  };

  const generateMutation = useGenerateSalesOrderEwb({
    mutation: {
      onSuccess: () => {
        invalidate();
        setGenerateOpen(false);
        toast({ title: "E-way bill generated" });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not generate e-way bill",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });
  const updateVehicleMutation = useUpdateSalesOrderEwbVehicle({
    mutation: {
      onSuccess: () => {
        invalidate();
        setVehicleOpen(false);
        toast({ title: "Vehicle updated" });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not update vehicle",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });
  const cancelMutation = useCancelSalesOrderEwb({
    mutation: {
      onSuccess: () => {
        invalidate();
        setCancelOpen(false);
        toast({ title: "E-way bill cancelled" });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not cancel e-way bill",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`/api/sales-orders/${orderId}/ewb.pdf`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Download failed (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ewb-${ewb?.number ?? orderNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      toast({
        title: "Could not download e-way bill",
        description:
          err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  };

  if (!connectionQuery.data?.connected) {
    return (
      <Card data-testid="ewb-panel">
        <CardHeader>
          <div className="flex items-center gap-3">
            <FileText className="h-6 w-6 text-amber-600" />
            <div>
              <CardTitle>E-way bill</CardTitle>
              <CardDescription>
                Connect your NIC EWB account to generate e-way bills from
                sales orders.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/integrations/ewb">Set up EWB integration</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const orderEligible = isOrderEwbEligible(orderStatus);

  return (
    <Card data-testid="ewb-panel">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <FileText className="h-6 w-6 text-amber-600" />
          <div>
            <CardTitle>E-way bill</CardTitle>
            <CardDescription>
              {ewb
                ? `EWB ${ewb.number}`
                : "No e-way bill has been generated for this order yet."}
            </CardDescription>
          </div>
        </div>
        <EwbStatusBadge ewb={ewb ?? null} />
      </CardHeader>
      <CardContent className="space-y-4">
        {ewb ? (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="grid flex-1 grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground font-medium">EWB number</p>
                <p className="font-mono" data-testid="text-ewb-number">
                  {ewb.number}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground font-medium">Generated</p>
                <p>{formatTime(ewb.date)}</p>
              </div>
              <div>
                <p className="text-muted-foreground font-medium">Valid until</p>
                <p data-testid="text-ewb-valid-until">
                  {formatTime(ewb.validUntil)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground font-medium">Vehicle</p>
                <p className="font-mono" data-testid="text-ewb-vehicle">
                  {ewb.vehicleNumber ?? "Not assigned"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground font-medium">Mode</p>
                <p>
                  {ewb.transportMode
                    ? TRANSPORT_MODE_LABELS[ewb.transportMode] ??
                      ewb.transportMode
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground font-medium">Distance</p>
                <p>{ewb.distanceKm != null ? `${ewb.distanceKm} km` : "—"}</p>
              </div>
              </div>
              {ewb.qrPayload && ewb.status === "active" && !ewb.isExpired && (
                <div className="flex flex-col items-center gap-1">
                  <img
                    src={`/api/sales-orders/${orderId}/ewb/qr.png`}
                    alt={`E-way bill ${ewb.number} QR code`}
                    className="h-32 w-32 rounded border bg-white p-1"
                    data-testid="img-ewb-qr"
                  />
                  <p className="text-xs text-muted-foreground">Scan for verification</p>
                </div>
              )}
            </div>
            {ewb.cancelledAt && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs">
                <p className="font-medium text-destructive">
                  Cancelled on {formatTime(ewb.cancelledAt)}
                </p>
                {ewb.cancelReason && (
                  <p className="text-muted-foreground mt-1">
                    {ewb.cancelReason}
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownload}
                disabled={downloading}
                data-testid="btn-download-ewb"
              >
                <Download className="mr-2 h-4 w-4" />
                {downloading ? "Preparing…" : "Download PDF"}
              </Button>
              {ewb.status === "active" && (
                <>
                  <Dialog open={vehicleOpen} onOpenChange={setVehicleOpen}>
                    <DialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="btn-update-ewb-vehicle"
                      >
                        <Truck className="mr-2 h-4 w-4" /> Update vehicle
                      </Button>
                    </DialogTrigger>
                    <UpdateVehicleDialog
                      onSubmit={(data) =>
                        updateVehicleMutation.mutate({ id: orderId, data })
                      }
                      isPending={updateVehicleMutation.isPending}
                      states={refQuery.data?.states ?? []}
                      currentMode={ewb.transportMode ?? "1"}
                      currentVehicle={ewb.vehicleNumber ?? ""}
                    />
                  </Dialog>
                  <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
                    <DialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        data-testid="btn-cancel-ewb"
                      >
                        <XCircle className="mr-2 h-4 w-4" /> Cancel EWB
                      </Button>
                    </DialogTrigger>
                    <CancelDialog
                      onSubmit={(data) =>
                        cancelMutation.mutate({ id: orderId, data })
                      }
                      isPending={cancelMutation.isPending}
                      ewbDate={ewb.date}
                    />
                  </Dialog>
                </>
              )}
              {(ewb.status === "cancelled" || ewb.isExpired) && orderEligible && (
                <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
                  <DialogTrigger asChild>
                    <Button
                      size="sm"
                      data-testid="btn-regenerate-ewb"
                    >
                      <Plus className="mr-2 h-4 w-4" /> Generate new EWB
                    </Button>
                  </DialogTrigger>
                  <GenerateDialog
                    onSubmit={(data) =>
                      generateMutation.mutate({ id: orderId, data })
                    }
                    isPending={generateMutation.isPending}
                    states={refQuery.data?.states ?? []}
                  />
                </Dialog>
              )}
            </div>
          </>
        ) : !orderEligible ? (
          <p className="text-sm text-muted-foreground">
            E-way bills can only be generated once the order is confirmed.
          </p>
        ) : (
          <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
            <DialogTrigger asChild>
              <Button size="sm" data-testid="btn-generate-ewb">
                <Plus className="mr-2 h-4 w-4" /> Generate e-way bill
              </Button>
            </DialogTrigger>
            <GenerateDialog
              onSubmit={(data) =>
                generateMutation.mutate({ id: orderId, data })
              }
              isPending={generateMutation.isPending}
              states={refQuery.data?.states ?? []}
            />
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}

function EwbStatusBadge({ ewb }: { ewb: EwbDetails | null }) {
  if (!ewb) return null;
  if (ewb.status === "cancelled") {
    return (
      <Badge variant="destructive" data-testid="ewb-badge">
        <XCircle className="h-3 w-3 mr-1" /> Cancelled
      </Badge>
    );
  }
  if (ewb.isExpired) {
    return (
      <Badge
        variant="outline"
        className="border-amber-400 text-amber-700 dark:text-amber-400"
        data-testid="ewb-badge"
      >
        <AlertTriangle className="h-3 w-3 mr-1" /> Expired
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-emerald-400 text-emerald-700 dark:text-emerald-400"
      data-testid="ewb-badge"
    >
      <CheckCircle2 className="h-3 w-3 mr-1" /> Active
    </Badge>
  );
}

interface EwbAddressDraft {
  legalName: string;
  addressLine1: string;
  city: string;
  pincode: string;
  stateCode: string;
}

interface GenerateData {
  transportMode: "1" | "2" | "3" | "4";
  distanceKm: number;
  vehicleNumber?: string | null;
  transporterId?: string | null;
  transporterName?: string | null;
  irn?: string | null;
  fromAddress?: {
    legalName: string;
    addressLine1: string;
    city: string;
    pincode: string;
    stateCode: number;
  } | null;
  toAddress?: {
    legalName: string;
    addressLine1: string;
    city: string;
    pincode: string;
    stateCode: number;
  } | null;
}

function emptyAddressDraft(): EwbAddressDraft {
  return {
    legalName: "",
    addressLine1: "",
    city: "",
    pincode: "",
    stateCode: "",
  };
}

function isAddressComplete(a: EwbAddressDraft): boolean {
  return Boolean(
    a.legalName &&
      a.addressLine1 &&
      a.city &&
      /^\d{6}$/.test(a.pincode) &&
      a.stateCode,
  );
}

function isAddressEmpty(a: EwbAddressDraft): boolean {
  return (
    !a.legalName &&
    !a.addressLine1 &&
    !a.city &&
    !a.pincode &&
    !a.stateCode
  );
}

function GenerateDialog({
  onSubmit,
  isPending,
  states,
}: {
  onSubmit: (data: GenerateData) => void;
  isPending: boolean;
  states: ReadonlyArray<{ code: number; name: string }>;
}) {
  const [transportMode, setTransportMode] = useState<"1" | "2" | "3" | "4">("1");
  const [distanceKm, setDistanceKm] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [transporterId, setTransporterId] = useState("");
  const [transporterName, setTransporterName] = useState("");
  const [useIrn, setUseIrn] = useState(false);
  const [irn, setIrn] = useState("");
  const [overrideAddresses, setOverrideAddresses] = useState(false);
  const [fromAddr, setFromAddr] = useState<EwbAddressDraft>(emptyAddressDraft);
  const [toAddr, setToAddr] = useState<EwbAddressDraft>(emptyAddressDraft);

  const irnValid = !useIrn || /^[A-Fa-f0-9]{64}$/.test(irn.trim());
  const addressesValid =
    useIrn ||
    !overrideAddresses ||
    (isAddressComplete(fromAddr) && isAddressComplete(toAddr));

  const buildAddress = (a: EwbAddressDraft) =>
    isAddressEmpty(a)
      ? null
      : {
          legalName: a.legalName.trim(),
          addressLine1: a.addressLine1.trim(),
          city: a.city.trim(),
          pincode: a.pincode.trim(),
          stateCode: Number(a.stateCode),
        };

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Generate e-way bill</DialogTitle>
        <DialogDescription>
          Required for shipments with invoice value over INR 50,000 in most
          states. Transport details are sent to the NIC e-way bill system.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-md border p-3">
          <input
            id="ewb-use-irn"
            type="checkbox"
            checked={useIrn}
            onChange={(e) => setUseIrn(e.target.checked)}
            data-testid="checkbox-ewb-use-irn"
          />
          <Label htmlFor="ewb-use-irn" className="text-sm font-normal">
            Use existing e-invoice IRN (faster — skips line items)
          </Label>
        </div>
        {useIrn && (
          <div>
            <Label htmlFor="ewb-irn">IRN</Label>
            <Input
              id="ewb-irn"
              placeholder="64-character IRN from your e-invoice"
              value={irn}
              onChange={(e) => setIrn(e.target.value.trim())}
              data-testid="input-ewb-irn"
            />
            {irn && !irnValid && (
              <p className="mt-1 text-xs text-destructive">
                IRN must be exactly 64 hexadecimal characters (0-9, a-f).
              </p>
            )}
          </div>
        )}
        <div>
          <Label>Transport mode</Label>
          <Select
            value={transportMode}
            onValueChange={(v) =>
              setTransportMode(v as "1" | "2" | "3" | "4")
            }
          >
            <SelectTrigger data-testid="select-transport-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Road</SelectItem>
              <SelectItem value="2">Rail</SelectItem>
              <SelectItem value="3">Air</SelectItem>
              <SelectItem value="4">Ship</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="ewb-distance">Distance (km)</Label>
          <Input
            id="ewb-distance"
            type="number"
            min={1}
            max={4000}
            value={distanceKm}
            onChange={(e) => setDistanceKm(e.target.value)}
            data-testid="input-ewb-distance"
          />
        </div>
        <div>
          <Label htmlFor="ewb-vehicle">
            Vehicle number {transportMode === "1" ? "(or transporter ID)" : "(optional)"}
          </Label>
          <Input
            id="ewb-vehicle"
            placeholder="MH12AB1234"
            value={vehicleNumber}
            onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
            data-testid="input-ewb-vehicle"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="ewb-transporter-id">Transporter ID (optional)</Label>
            <Input
              id="ewb-transporter-id"
              value={transporterId}
              onChange={(e) => setTransporterId(e.target.value.toUpperCase())}
              data-testid="input-ewb-transporter-id"
            />
          </div>
          <div>
            <Label htmlFor="ewb-transporter-name">Transporter (optional)</Label>
            <Input
              id="ewb-transporter-name"
              value={transporterName}
              onChange={(e) => setTransporterName(e.target.value)}
              data-testid="input-ewb-transporter-name"
            />
          </div>
        </div>
        {!useIrn && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <input
                id="ewb-override-addr"
                type="checkbox"
                checked={overrideAddresses}
                onChange={(e) => setOverrideAddresses(e.target.checked)}
                data-testid="checkbox-override-addresses"
              />
              <Label
                htmlFor="ewb-override-addr"
                className="text-sm font-normal"
              >
                Override dispatch / ship-to addresses (otherwise the warehouse
                and customer billing address are used)
              </Label>
            </div>
            {overrideAddresses && (
              <div className="space-y-3">
                <AddressFields
                  title="Dispatch from"
                  prefix="from"
                  value={fromAddr}
                  onChange={setFromAddr}
                  states={states}
                />
                <AddressFields
                  title="Ship to"
                  prefix="to"
                  value={toAddr}
                  onChange={setToAddr}
                  states={states}
                />
              </div>
            )}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button
          onClick={() =>
            onSubmit({
              transportMode,
              distanceKm: Number(distanceKm),
              vehicleNumber: vehicleNumber || null,
              transporterId: transporterId || null,
              transporterName: transporterName || null,
              irn: useIrn ? irn.trim() : null,
              fromAddress:
                !useIrn && overrideAddresses ? buildAddress(fromAddr) : null,
              toAddress:
                !useIrn && overrideAddresses ? buildAddress(toAddr) : null,
            })
          }
          disabled={
            isPending ||
            !distanceKm ||
            !irnValid ||
            (useIrn && !irn) ||
            !addressesValid
          }
          data-testid="btn-submit-generate-ewb"
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Generate
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function AddressFields({
  title,
  prefix,
  value,
  onChange,
  states,
}: {
  title: string;
  prefix: string;
  value: EwbAddressDraft;
  onChange: (next: EwbAddressDraft) => void;
  states: ReadonlyArray<{ code: number; name: string }>;
}) {
  const set = (patch: Partial<EwbAddressDraft>) =>
    onChange({ ...value, ...patch });
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <Input
        placeholder="Legal name"
        value={value.legalName}
        onChange={(e) => set({ legalName: e.target.value })}
        data-testid={`input-${prefix}-legal-name`}
      />
      <Input
        placeholder="Address line"
        value={value.addressLine1}
        onChange={(e) => set({ addressLine1: e.target.value })}
        data-testid={`input-${prefix}-address`}
      />
      <div className="grid grid-cols-2 gap-2">
        <Input
          placeholder="City"
          value={value.city}
          onChange={(e) => set({ city: e.target.value })}
          data-testid={`input-${prefix}-city`}
        />
        <Input
          placeholder="Pincode"
          value={value.pincode}
          onChange={(e) =>
            set({ pincode: e.target.value.replace(/\D/g, "").slice(0, 6) })
          }
          data-testid={`input-${prefix}-pincode`}
        />
      </div>
      <Select
        value={value.stateCode}
        onValueChange={(v) => set({ stateCode: v })}
      >
        <SelectTrigger data-testid={`select-${prefix}-state`}>
          <SelectValue placeholder="State" />
        </SelectTrigger>
        <SelectContent>
          {states.map((s) => (
            <SelectItem key={s.code} value={String(s.code)}>
              {s.code} · {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface UpdateVehicleData {
  vehicleNumber: string;
  fromPlace: string;
  fromState: number;
  reasonCode: "1" | "2" | "3" | "4";
  reasonRem: string;
  transportMode: "1" | "2" | "3" | "4";
}

function UpdateVehicleDialog({
  onSubmit,
  isPending,
  states,
  currentMode,
  currentVehicle,
}: {
  onSubmit: (data: UpdateVehicleData) => void;
  isPending: boolean;
  states: ReadonlyArray<{ code: number; name: string }>;
  currentMode: string;
  currentVehicle: string;
}) {
  const [vehicleNumber, setVehicleNumber] = useState(currentVehicle);
  const [fromPlace, setFromPlace] = useState("");
  const [fromState, setFromState] = useState<string>("");
  const [reasonCode, setReasonCode] = useState<"1" | "2" | "3" | "4">("3");
  const [reasonRem, setReasonRem] = useState("Vehicle updated");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Update vehicle (Part B)</DialogTitle>
        <DialogDescription>
          Send the new vehicle number and place to NIC. The validity is
          recalculated based on the remaining distance.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <Label htmlFor="upd-vehicle">Vehicle number</Label>
          <Input
            id="upd-vehicle"
            value={vehicleNumber}
            onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
            data-testid="input-update-vehicle"
          />
        </div>
        <div>
          <Label htmlFor="upd-from-place">From place</Label>
          <Input
            id="upd-from-place"
            value={fromPlace}
            onChange={(e) => setFromPlace(e.target.value)}
            data-testid="input-update-from-place"
          />
        </div>
        <div>
          <Label>From state</Label>
          <Select value={fromState} onValueChange={setFromState}>
            <SelectTrigger data-testid="select-update-from-state">
              <SelectValue placeholder="Select state" />
            </SelectTrigger>
            <SelectContent>
              {states.map((s) => (
                <SelectItem key={s.code} value={String(s.code)}>
                  {s.code} · {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Reason</Label>
          <Select
            value={reasonCode}
            onValueChange={(v) => setReasonCode(v as "1" | "2" | "3" | "4")}
          >
            <SelectTrigger data-testid="select-update-reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Due to break-down</SelectItem>
              <SelectItem value="2">Due to transhipment</SelectItem>
              <SelectItem value="3">Others</SelectItem>
              <SelectItem value="4">First Time</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="upd-rem">Note</Label>
          <Input
            id="upd-rem"
            value={reasonRem}
            onChange={(e) => setReasonRem(e.target.value)}
            data-testid="input-update-rem"
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          onClick={() =>
            onSubmit({
              vehicleNumber,
              fromPlace,
              fromState: Number(fromState),
              reasonCode,
              reasonRem,
              transportMode: (currentMode || "1") as "1" | "2" | "3" | "4",
            })
          }
          disabled={
            isPending || !vehicleNumber || !fromPlace || !fromState
          }
          data-testid="btn-submit-update-vehicle"
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Update vehicle
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

interface CancelData {
  reasonCode: "1" | "2" | "3" | "4";
  reasonRem: string;
}

function CancelDialog({
  onSubmit,
  isPending,
  ewbDate,
}: {
  onSubmit: (data: CancelData) => void;
  isPending: boolean;
  ewbDate: string | null;
}) {
  const [reasonCode, setReasonCode] = useState<"1" | "2" | "3" | "4">("4");
  const [reasonRem, setReasonRem] = useState("Cancelled by user");
  const ageHours = ewbDate
    ? (Date.now() - new Date(ewbDate).getTime()) / 3600000
    : 0;
  const tooOld = ageHours > 24;
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Cancel e-way bill</DialogTitle>
        <DialogDescription>
          E-way bills can only be cancelled within 24 hours of generation.
          {tooOld && (
            <span className="text-destructive font-medium block mt-2">
              This bill is older than 24 hours and can no longer be cancelled
              at NIC.
            </span>
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <Label>Reason</Label>
          <Select
            value={reasonCode}
            onValueChange={(v) => setReasonCode(v as "1" | "2" | "3" | "4")}
          >
            <SelectTrigger data-testid="select-cancel-reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Duplicate</SelectItem>
              <SelectItem value="2">Order Cancelled</SelectItem>
              <SelectItem value="3">Data Entry Mistake</SelectItem>
              <SelectItem value="4">Others</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="cancel-rem">Remarks</Label>
          <Input
            id="cancel-rem"
            value={reasonRem}
            onChange={(e) => setReasonRem(e.target.value)}
            data-testid="input-cancel-rem"
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          onClick={() => onSubmit({ reasonCode, reasonRem })}
          disabled={isPending || tooOld}
          data-testid="btn-submit-cancel-ewb"
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Cancel EWB
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
