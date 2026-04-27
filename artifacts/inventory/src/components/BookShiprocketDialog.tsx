import { useState } from "react";
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
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  useBookShiprocketShipment,
  useListShiprocketCouriers,
  getGetSalesOrderQueryKey,
  getListSalesOrderShipmentsQueryKey,
} from "@/lib/queryKeys";
import { Loader2, RefreshCw } from "lucide-react";
import type { ShiprocketCourierOption } from "@workspace/api-client-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shipmentId: number;
  shipmentNumber: string;
  salesOrderId: number;
  customerName: string;
}

export function BookShiprocketDialog({
  open,
  onOpenChange,
  shipmentId,
  shipmentNumber,
  salesOrderId,
  customerName,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [paymentMethod, setPaymentMethod] = useState<"Prepaid" | "COD">(
    "Prepaid",
  );
  const [pickupLocation, setPickupLocation] = useState("");
  const [weightKg, setWeightKg] = useState("0.5");
  const [lengthCm, setLengthCm] = useState("15");
  const [breadthCm, setBreadthCm] = useState("15");
  const [heightCm, setHeightCm] = useState("10");

  const [name, setName] = useState(customerName);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [stateName, setStateName] = useState("");
  const [pincode, setPincode] = useState("");
  const [pickupPincode, setPickupPincode] = useState("");

  const [courierOptions, setCourierOptions] = useState<
    ShiprocketCourierOption[]
  >([]);
  const [selectedCourierId, setSelectedCourierId] = useState<string>("");
  const [resolvedPickupPincode, setResolvedPickupPincode] = useState<
    string | null
  >(null);

  const couriersMutation = useListShiprocketCouriers({
    mutation: {
      onSuccess: (data) => {
        setCourierOptions(data.couriers);
        setResolvedPickupPincode(data.pickupPincode);
        if (data.couriers.length === 0) {
          toast({
            title: "No couriers available",
            description:
              "Shiprocket returned no serviceable couriers for this route and weight.",
            variant: "destructive",
          });
          setSelectedCourierId("");
        } else {
          // Default to the cheapest option (the API already sorts by rate).
          setSelectedCourierId(String(data.couriers[0]!.courierId));
        }
      },
      onError: (err: unknown) => {
        setCourierOptions([]);
        setSelectedCourierId("");
        toast({
          title: "Could not fetch courier rates",
          description:
            err instanceof Error
              ? err.message
              : "Check the pincodes and weight, then try again.",
          variant: "destructive",
        });
      },
    },
  });

  const bookMutation = useBookShiprocketShipment({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({
          queryKey: getListSalesOrderShipmentsQueryKey(salesOrderId),
        });
        queryClient.invalidateQueries({
          queryKey: getGetSalesOrderQueryKey(salesOrderId),
        });
        toast({
          title: data.alreadyBooked ? "Already booked" : "Shipment booked",
          description: data.shipment.awb
            ? `AWB ${data.shipment.awb}${
                data.shipment.courierName
                  ? ` via ${data.shipment.courierName}`
                  : ""
              }`
            : "Booking submitted to Shiprocket.",
        });
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not book shipment",
          description:
            err instanceof Error
              ? err.message
              : "Check the customer address and try again.",
          variant: "destructive",
        });
      },
    },
  });

  const canFetchRates =
    Number(weightKg) > 0 && /^[0-9]{6}$/u.test(pincode.trim());

  const handleFetchRates = () => {
    if (!canFetchRates) return;
    couriersMutation.mutate({
      id: shipmentId,
      data: {
        deliveryPincode: pincode.trim(),
        weightKg: Number(weightKg),
        cod: paymentMethod === "COD",
        pickupPincode: pickupPincode.trim() || null,
      },
    });
  };

  const handleSubmit = () => {
    const courierId = selectedCourierId
      ? Number(selectedCourierId)
      : undefined;
    bookMutation.mutate({
      id: shipmentId,
      data: {
        paymentMethod,
        pickupLocation: pickupLocation.trim() || null,
        weightKg: Number(weightKg),
        lengthCm: Number(lengthCm),
        breadthCm: Number(breadthCm),
        heightCm: Number(heightCm),
        courierId: courierId ?? null,
        customer: {
          name: name.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          addressLine1: addressLine1.trim() || null,
          addressLine2: addressLine2.trim() || null,
          city: city.trim() || null,
          state: stateName.trim() || null,
          pincode: pincode.trim() || null,
          country: null,
        },
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Book {shipmentNumber} on Shiprocket</DialogTitle>
          <DialogDescription>
            Fill in the package details and recipient address, then fetch
            courier rates and pick the one you want before booking.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sr-payment">Payment method</Label>
              <Select
                value={paymentMethod}
                onValueChange={(v) =>
                  setPaymentMethod(v as "Prepaid" | "COD")
                }
              >
                <SelectTrigger
                  id="sr-payment"
                  data-testid="select-shiprocket-payment-method"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Prepaid">Prepaid</SelectItem>
                  <SelectItem value="COD">Cash on delivery</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sr-pickup">Pickup location (optional)</Label>
              <Input
                id="sr-pickup"
                value={pickupLocation}
                onChange={(e) => setPickupLocation(e.target.value)}
                placeholder="As configured in Shiprocket"
                data-testid="input-shiprocket-pickup"
              />
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sr-weight">Weight (kg)</Label>
              <Input
                id="sr-weight"
                type="number"
                step="0.01"
                min="0.01"
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value)}
                data-testid="input-shiprocket-weight"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sr-length">Length (cm)</Label>
              <Input
                id="sr-length"
                type="number"
                step="0.1"
                min="1"
                value={lengthCm}
                onChange={(e) => setLengthCm(e.target.value)}
                data-testid="input-shiprocket-length"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sr-breadth">Breadth (cm)</Label>
              <Input
                id="sr-breadth"
                type="number"
                step="0.1"
                min="1"
                value={breadthCm}
                onChange={(e) => setBreadthCm(e.target.value)}
                data-testid="input-shiprocket-breadth"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sr-height">Height (cm)</Label>
              <Input
                id="sr-height"
                type="number"
                step="0.1"
                min="1"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                data-testid="input-shiprocket-height"
              />
            </div>
          </div>

          <div className="border-t pt-3 space-y-3">
            <p className="text-sm font-medium">Delivery address</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="sr-name">Recipient name</Label>
                <Input
                  id="sr-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="input-shiprocket-name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sr-phone">Phone</Label>
                <Input
                  id="sr-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="10-digit mobile"
                  data-testid="input-shiprocket-phone"
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="sr-email">Email (optional)</Label>
                <Input
                  id="sr-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="input-shiprocket-email"
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="sr-addr1">Address line 1</Label>
                <Input
                  id="sr-addr1"
                  value={addressLine1}
                  onChange={(e) => setAddressLine1(e.target.value)}
                  data-testid="input-shiprocket-addr1"
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="sr-addr2">Address line 2 (optional)</Label>
                <Input
                  id="sr-addr2"
                  value={addressLine2}
                  onChange={(e) => setAddressLine2(e.target.value)}
                  data-testid="input-shiprocket-addr2"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sr-city">City</Label>
                <Input
                  id="sr-city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  data-testid="input-shiprocket-city"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sr-state">State</Label>
                <Input
                  id="sr-state"
                  value={stateName}
                  onChange={(e) => setStateName(e.target.value)}
                  data-testid="input-shiprocket-state"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sr-pincode">Pincode</Label>
                <Input
                  id="sr-pincode"
                  value={pincode}
                  onChange={(e) => setPincode(e.target.value)}
                  inputMode="numeric"
                  data-testid="input-shiprocket-pincode"
                />
              </div>
            </div>
          </div>

          <div className="border-t pt-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">Pick a courier</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleFetchRates}
                disabled={!canFetchRates || couriersMutation.isPending}
                data-testid="btn-fetch-shiprocket-rates"
              >
                {couriersMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {courierOptions.length > 0
                  ? "Refresh rates"
                  : "Get courier rates"}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="sr-pickup-pincode">
                  Pickup pincode (optional)
                </Label>
                <Input
                  id="sr-pickup-pincode"
                  value={pickupPincode}
                  onChange={(e) => setPickupPincode(e.target.value)}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={resolvedPickupPincode ?? "Defaults to org pincode"}
                  data-testid="input-shiprocket-book-pickup-pincode"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sr-courier">Courier</Label>
                <Select
                  value={selectedCourierId}
                  onValueChange={setSelectedCourierId}
                  disabled={courierOptions.length === 0}
                >
                  <SelectTrigger
                    id="sr-courier"
                    data-testid="select-shiprocket-courier"
                  >
                    <SelectValue
                      placeholder={
                        couriersMutation.isPending
                          ? "Loading rates…"
                          : "Fetch rates first"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {courierOptions.map((c) => (
                      <SelectItem
                        key={c.courierId}
                        value={String(c.courierId)}
                      >
                        {c.courierName} — ₹{c.rate.toFixed(0)}
                        {c.estimatedDeliveryDays != null
                          ? ` (~${c.estimatedDeliveryDays}d)`
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {courierOptions.length === 0 && !couriersMutation.isPending ? (
              <p className="text-xs text-muted-foreground">
                Enter a 6-digit delivery pincode and weight, then fetch rates
                to see available couriers. If you skip this step, Shiprocket
                will pick a courier for you.
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={bookMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={bookMutation.isPending}
            data-testid="btn-confirm-book-shiprocket"
          >
            {bookMutation.isPending ? "Booking…" : "Book shipment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
