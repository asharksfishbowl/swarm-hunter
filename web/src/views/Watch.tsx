import { useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { api, cleanName, decodeText, when } from "@/api.ts"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx"
import type { ChurchBundle } from "@/types.ts"

export function Watch() {
  const [bundle, setBundle] = useState<ChurchBundle | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      setBundle(await api<ChurchBundle>("/api/church"))
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "The Church API did not answer.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const status = bundle?.status
  const vigil = bundle?.vigil?.vigils[0]
  const stats = [
    ["Congregation", status?.congregation_size],
    ["Canon", status?.canon_size],
    ["Blessed", status?.blessed_count],
    ["Prophet seats", status ? `${status.prophets_filled}/64` : null],
  ] as const

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs tracking-[0.18em] text-claw uppercase">Watch</p>
          <h2 className="font-heading text-3xl">The tide right now</h2>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw data-icon="inline-start" />
          {loading ? "Reading" : "Refresh"}
        </Button>
      </div>

      {error ? (
        <Card>
          <CardContent className="text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      {bundle?.errors.length ? (
        <p className="text-sm text-muted-foreground">{bundle.errors.join(" ")}</p>
      ) : null}

      {!bundle ? (
        <Card>
          <CardContent>{loading ? "Reading the Church…" : "The Church has not answered yet."}</CardContent>
        </Card>
      ) : (
      <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(([label, value]) => (
          <Card key={label} size="sm">
            <CardHeader>
              <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
              <CardTitle className="font-heading text-3xl">
                {value == null ? "—" : typeof value === "number" ? value.toLocaleString() : value}
              </CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <p className="text-xs tracking-wide text-muted-foreground uppercase">Tenet of the day</p>
          <CardTitle className="font-heading text-2xl">
            {bundle?.devotion?.tenet_of_the_day.name ?? (loading ? "Listening…" : "Unread")}
          </CardTitle>
        </CardHeader>
          <CardContent className="grid gap-3">
            <p className="claw-rule text-base leading-relaxed">
              {bundle?.devotion ? decodeText(bundle.devotion.verse.text) : "The daily verse has not arrived."}
            </p>
          <p className="text-sm text-muted-foreground">
            {bundle?.devotion?.verse.citation} · {bundle?.devotion?.verse.author}
          </p>
          {status && !status.prophet_seats_open ? (
            <p className="text-sm text-muted-foreground">
              All 64 Prophet seats are sealed. The Profit stands in the congregation and earns a blessing by being worth reading.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>{vigil?.title ?? "Vigil"}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {vigil?.lit ? "The flame is lit." : "The flame is dark."} {vigil?.human_candles ?? 0} human candles.
            </p>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="claw-rule font-heading text-xl leading-snug">
              {vigil?.current_call?.text ?? "No call is open."}
            </p>
            <div className="flex flex-wrap gap-2">
              {(vigil?.present ?? []).map((name) => (
                <Badge key={name} variant="secondary">
                  {cleanName(name)}
                </Badge>
              ))}
              {vigil && vigil.present.length === 0 ? (
                <span className="text-sm text-muted-foreground">No agent is present.</span>
              ) : null}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent voices</CardTitle>
          </CardHeader>
          <CardContent className="grid max-h-80 gap-3 overflow-auto">
            {(vigil?.responses ?? []).slice(0, 6).map((voice) => (
              <article key={voice.id} className="grid gap-1">
                <p className="text-sm text-claw">{cleanName(voice.name)}</p>
                <p className="leading-relaxed">{decodeText(voice.text)}</p>
                <p className="text-xs text-muted-foreground">{when(voice.at)}</p>
              </article>
            ))}
            {!vigil && !loading ? <p className="text-sm text-muted-foreground">No vigil record.</p> : null}
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">Fetched {when(bundle.fetched_at)}</p>
      </>
      )}
    </div>
  )
}
