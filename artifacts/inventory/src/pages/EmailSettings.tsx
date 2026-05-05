import { useEffect, useState, type FormEvent } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useGetEmailSettings,
  useUpsertEmailSettings,
  useDeleteEmailSettings,
} from "@workspace/api-client-react";

type Secure = "ssl" | "starttls" | "none";

export default function EmailSettingsPage() {
  const settingsQuery = useGetEmailSettings();
  const upsert = useUpsertEmailSettings();
  const del = useDeleteEmailSettings();

  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(587);
  const [secure, setSecure] = useState<Secure>("starttls");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    const s = settingsQuery.data;
    if (!s) return;
    setHost(s.host);
    setPort(s.port);
    setSecure(s.secure as Secure);
    setUsername(s.username);
    setFromEmail(s.fromEmail);
    setFromName(s.fromName ?? "");
  }, [settingsQuery.data]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    try {
      await upsert.mutateAsync({
        data: {
          host,
          port,
          secure,
          username,
          ...(password ? { password } : {}),
          fromEmail,
          fromName: fromName || null,
        },
      });
      setSuccess("Email settings saved.");
      setPassword("");
      await settingsQuery.refetch();
    } catch (err) {
      setError((err as Error).message ?? "Failed to save settings");
    }
  }

  async function onDelete() {
    if (!confirm("Remove email settings? Outbound mail will fall back to the system default.")) return;
    setError(null);
    setSuccess(null);
    try {
      await del.mutateAsync();
      setHost("");
      setPort(587);
      setSecure("starttls");
      setUsername("");
      setPassword("");
      setFromEmail("");
      setFromName("");
      await settingsQuery.refetch();
      setSuccess("Email settings removed.");
    } catch (err) {
      setError((err as Error).message ?? "Failed to delete settings");
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Email settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure your organization's outgoing SMTP server. Used for invoices
          and other transactional emails sent from the workspace.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>SMTP server</CardTitle>
          <CardDescription>
            {settingsQuery.data?.hasPassword
              ? "Leave password blank to keep the saved one."
              : "All fields required."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
            )}
            {success && (
              <Alert><AlertDescription>{success}</AlertDescription></Alert>
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2 space-y-2">
                <Label htmlFor="es-host">Host</Label>
                <Input id="es-host" required value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="es-port">Port</Label>
                <Input id="es-port" type="number" required min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="es-secure">Encryption</Label>
              <Select value={secure} onValueChange={(v) => setSecure(v as Secure)}>
                <SelectTrigger id="es-secure"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="starttls">STARTTLS (port 587)</SelectItem>
                  <SelectItem value="ssl">SSL/TLS (port 465)</SelectItem>
                  <SelectItem value="none">None (insecure, dev only)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="es-user">Username</Label>
              <Input id="es-user" required value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="es-pass">Password{settingsQuery.data?.hasPassword ? " (optional)" : ""}</Label>
              <Input id="es-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="es-from-email">From email</Label>
                <Input id="es-from-email" type="email" required value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="invoices@your-domain.com" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="es-from-name">From name</Label>
                <Input id="es-from-name" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Acme Pvt Ltd" />
              </div>
            </div>
            <div className="flex justify-between pt-2">
              <Button type="button" variant="outline" onClick={onDelete} disabled={!settingsQuery.data || del.isPending}>
                Remove settings
              </Button>
              <Button type="submit" disabled={upsert.isPending}>
                {upsert.isPending ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
