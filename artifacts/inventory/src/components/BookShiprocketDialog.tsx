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
  getGetSalesOrderQueryKey,
  getListSalesOrderShipmentsQueryKey,
} from "@/lib/queryKeys";

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

  const handleSubmit = () => {
    bookMutation.mutate({
      id: shipmentId,
      data: {
        paymentMethod,
        pickupLocation: pickupLocation.trim() || null,
        weightKg: Number(weightKg),
        lengthCm: Number(lengthCm),
        breadthCm: Number(breadthCm),
        heightCm: Number(heightCm),
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Book {shipmentNumber} on Shiprocket</DialogTitle>
          <DialogDescription>
            We'll create a Shiprocket order, assign an AWB and try to generate
            a label. The dimensions and weight are used to calculate courier
            rates.
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
