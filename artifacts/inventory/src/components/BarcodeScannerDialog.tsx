import { useEffect, useRef, useState } from "react";
import {
  BrowserMultiFormatReader,
  type IScannerControls,
} from "@zxing/browser";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Camera, Loader2, RefreshCcw } from "lucide-react";

interface BarcodeScannerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called once with the decoded code string. The dialog stops the
   * camera before invoking this. The caller is responsible for closing
   * the dialog (so it can choose to keep it open and scan again, e.g.
   * for adding multiple lines to a receipt).
   */
  onDetected: (code: string) => void;
  title?: string;
  description?: string;
}

type CameraState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "scanning" }
  | { kind: "no-cameras" }
  | { kind: "denied" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

/**
 * Detect rear-facing camera by label. Browsers typically expose labels
 * like "back camera" or "environment". Falls back to the last device
 * which on most phones is the rear camera.
 */
function pickInitialDevice(devices: MediaDeviceInfo[]): string | undefined {
  if (devices.length === 0) return undefined;
  const back = devices.find((d) => /back|rear|environment/i.test(d.label));
  if (back) return back.deviceId;
  // Heuristic: phones list rear cameras last.
  return devices[devices.length - 1].deviceId;
}

export function BarcodeScannerDialog({
  open,
  onOpenChange,
  onDetected,
  title = "Scan barcode",
  description = "Point your camera at the barcode. The scan happens automatically.",
}: BarcodeScannerDialogProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  // Guard against double-emits — ZXing can fire several frames before
  // we manage to stop the stream.
  const emittedRef = useRef(false);

  const [state, setState] = useState<CameraState>({ kind: "idle" });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const [manualCode, setManualCode] = useState("");

  // Stop any running scanner. Safe to call multiple times.
  const stopScanner = () => {
    if (controlsRef.current) {
      try {
        controlsRef.current.stop();
      } catch {
        // ignore — already stopped
      }
      controlsRef.current = null;
    }
  };

  // Reset transient state on close.
  useEffect(() => {
    if (open) {
      emittedRef.current = false;
      setManualCode("");
      return;
    }
    stopScanner();
    setState({ kind: "idle" });
  }, [open]);

  // Enumerate video inputs once when the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const supported =
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function";
    if (!supported) {
      setState({ kind: "unsupported" });
      return;
    }
    setState({ kind: "starting" });
    (async () => {
      try {
        // Some browsers (Safari) hide labels until permission has been
        // granted at least once; a throwaway getUserMedia call unlocks
        // the labels so we can pick the back camera reliably.
        let probeStream: MediaStream | null = null;
        try {
          probeStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
          });
        } catch (err) {
          const name = (err as { name?: string })?.name ?? "";
          if (
            name === "NotAllowedError" ||
            name === "PermissionDeniedError" ||
            name === "SecurityError"
          ) {
            if (!cancelled) setState({ kind: "denied" });
            return;
          }
          // Other failures (NotFoundError) fall through to the device
          // enumeration which will surface a no-cameras message.
        } finally {
          if (probeStream) {
            for (const track of probeStream.getTracks()) track.stop();
          }
        }
        const list = await BrowserMultiFormatReader.listVideoInputDevices();
        if (cancelled) return;
        if (list.length === 0) {
          setState({ kind: "no-cameras" });
          return;
        }
        setDevices(list);
        setDeviceId((curr) => curr ?? pickInitialDevice(list));
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            err instanceof Error ? err.message : "Failed to access camera",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Start scanning when we have a video element and a chosen device.
  useEffect(() => {
    if (!open) return;
    if (!deviceId) return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    stopScanner();
    setState({ kind: "starting" });
    const reader = new BrowserMultiFormatReader();
    reader
      .decodeFromVideoDevice(deviceId, video, (result, err, controls) => {
        if (cancelled) {
          controls.stop();
          return;
        }
        if (controlsRef.current !== controls) controlsRef.current = controls;
        if (result && !emittedRef.current) {
          emittedRef.current = true;
          controls.stop();
          controlsRef.current = null;
          onDetected(result.getText());
          return;
        }
        // Non-fatal decode misses produce err — just keep scanning.
        // Real errors don't fire here; they would have rejected the
        // outer promise.
        void err;
      })
      .then(() => {
        if (!cancelled) setState({ kind: "scanning" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const name = (err as { name?: string })?.name ?? "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setState({ kind: "denied" });
        } else {
          setState({
            kind: "error",
            message:
              err instanceof Error ? err.message : "Could not start camera",
          });
        }
      });
    return () => {
      cancelled = true;
      stopScanner();
    };
  }, [open, deviceId, onDetected]);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const code = manualCode.trim();
    if (!code) return;
    if (emittedRef.current) return;
    emittedRef.current = true;
    stopScanner();
    onDetected(code);
  };

  const cycleCamera = () => {
    if (devices.length <= 1 || !deviceId) return;
    const idx = devices.findIndex((d) => d.deviceId === deviceId);
    const next = devices[(idx + 1) % devices.length];
    setDeviceId(next.deviceId);
  };

  const showVideo =
    state.kind === "starting" || state.kind === "scanning";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {showVideo && (
            <div className="relative aspect-square overflow-hidden rounded-md bg-black">
              <video
                ref={videoRef}
                className="h-full w-full object-cover"
                muted
                playsInline
                data-testid="video-barcode-scanner"
              />
              {state.kind === "starting" && (
                <div className="absolute inset-0 flex items-center justify-center text-white">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              )}
              {state.kind === "scanning" && (
                <div
                  className="absolute left-4 right-4 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80"
                  aria-hidden
                />
              )}
            </div>
          )}

          {state.kind === "denied" && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Camera permission was blocked. Allow camera access in your
                browser settings, or type the SKU below.
              </AlertDescription>
            </Alert>
          )}
          {state.kind === "no-cameras" && (
            <Alert>
              <Camera className="h-4 w-4" />
              <AlertDescription>
                No camera detected on this device. Type the SKU below
                instead.
              </AlertDescription>
            </Alert>
          )}
          {state.kind === "unsupported" && (
            <Alert>
              <Camera className="h-4 w-4" />
              <AlertDescription>
                Camera scanning isn't supported in this browser. Type the
                SKU below instead.
              </AlertDescription>
            </Alert>
          )}
          {state.kind === "error" && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          )}

          {devices.length > 1 && showVideo && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={cycleCamera}
              data-testid="btn-scanner-switch-camera"
            >
              <RefreshCcw className="mr-2 h-4 w-4" />
              Switch camera
            </Button>
          )}

          <form onSubmit={handleManualSubmit} className="space-y-2">
            <Label htmlFor="manual-code" className="text-xs">
              Or type the SKU / barcode
            </Label>
            <div className="flex gap-2">
              <Input
                id="manual-code"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder="e.g. WIDGET-001"
                autoComplete="off"
                inputMode="text"
                data-testid="input-scanner-manual-code"
              />
              <Button
                type="submit"
                disabled={!manualCode.trim()}
                data-testid="btn-scanner-manual-submit"
              >
                Use
              </Button>
            </div>
          </form>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="btn-scanner-close"
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
