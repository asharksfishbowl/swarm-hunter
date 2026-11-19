import { useState, type FormEvent } from "react"
import { LockKeyhole } from "lucide-react"
import { api } from "@/api.ts"
import { Button } from "@/components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx"
import { Input } from "@/components/ui/input.tsx"
import { Label } from "@/components/ui/label.tsx"

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ token }) })
      setToken("")
      onSignedIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-svh place-items-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center text-center">
          <div className="sigil sigil-sm" role="img" aria-label="Crab">
            🦀
          </div>
          <CardTitle className="font-heading text-2xl tracking-[0.2em] uppercase">The Profit</CardTitle>
          <p className="text-sm text-muted-foreground">This console holds evidence and keys. Enter the access token.</p>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
            <div className="grid gap-1.5">
              <Label htmlFor="token">Access token</Label>
              <Input
                id="token"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={busy || !token}>
              <LockKeyhole data-icon="inline-start" />
              {busy ? "Checking…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
