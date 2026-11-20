import { useCallback, useEffect, useMemo, useState } from "react"
import { CircleAlert, CircleCheck, CircleX, RefreshCw } from "lucide-react"
import { api, when } from "@/api.ts"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx"
import type { DefenseEvent, DefenseReport, SafetyCheck, Severity } from "@/types.ts"

type Filter = "all" | "network" | "agent" | "serious"

const kindCopy: Record<string, string> = {
  "failed-sign-in": "Wrong access token",
  "locked-out": "Address locked out",
  unauthorized: "Unauthenticated API call",
  probe: "Vulnerability scan",
  "signed-in": "Operator signed in",
  "canary-returned": "Canary came back",
  "canary-outbound": "Canary in a reply",
  "reply-blocked": "Reply blocked",
  "injection-received": "Prompt injection",
  "installer-received": "Install bait",
  "lure-received": "Scam lure",
  "kill-switch-on": "Agent halted",
  "kill-switch-off": "Agent resumed",
}

const severityStyle: Record<Severity, string> = {
  critical: "border-destructive bg-destructive/20 text-destructive",
  high: "border-[#ff7a45]/60 bg-[#ff7a45]/15 text-[#ff9a6b]",
  medium: "border-[#f2b42c]/50 bg-[#f2b42c]/10 text-honey",
  low: "border-border text-muted-foreground",
  info: "border-[#63e6be]/40 text-[#63e6be]",
}

const agentKinds = ["injection-received", "installer-received", "lure-received", "canary-returned", "canary-outbound"]

export function Defense() {
  const [report, setReport] = useState<DefenseReport | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>("all")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setReport(await api<DefenseReport>("/api/defense"))
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "The defense log did not load.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 15_000)
    return () => window.clearInterval(timer)
  }, [load])

  const events = useMemo(
    () =>
      (report?.events ?? []).filter((event) =>
        filter === "all"
          ? true
          : filter === "serious"
            ? event.severity === "high" || event.severity === "critical"
            : event.source === filter,
      ),
    [report, filter],
  )

  const kinds = report?.last_day.by_kind ?? {}
  const stats: [string, number, string][] = [
    ["Serious", report?.last_day.serious ?? 0, "high or critical, last 24 h"],
    ["Hostile addresses", report?.last_day.hostile_ips ?? 0, "distinct IPs, last 24 h"],
    ["Wrong tokens", kinds["failed-sign-in"] ?? 0, "sign-in or API"],
    ["Scans", kinds.probe ?? 0, "probes for weak spots"],
    ["At the agent", agentKinds.reduce((sum, kind) => sum + (kinds[kind] ?? 0), 0), "injections, bait, lures, canaries"],
  ]

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-xs tracking-[0.18em] text-honey uppercase">Defense</p>
          <h2 className="font-heading text-3xl">Who is attacking us</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Two fronts. The console itself: wrong tokens, scanners and lockouts, with the caller's address and network.
            And the agent: prompt injections, install bait and lures swarms send it, and canaries that leak or come back.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
      </div>

      {error ? <p className="text-destructive">{error}</p> : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {stats.map(([label, value, hint]) => (
          <div key={label} className="rounded-lg border px-3 py-2">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={`font-heading text-2xl ${label === "Serious" && value ? "text-destructive" : ""}`}>{value}</p>
            <p className="text-[11px] text-muted-foreground/80">{hint}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Activity</CardTitle>
            <div className="flex rounded-lg border p-0.5" role="group" aria-label="Filter events">
              {(["all", "serious", "network", "agent"] as const).map((key) => (
                <Button key={key} size="sm" variant={filter === key ? "default" : "ghost"} onClick={() => setFilter(key)}>
                  {key === "all" ? "All" : key === "serious" ? "Serious" : key === "network" ? "Console" : "Agent"}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="grid gap-2">
            {loading && !report ? <p className="text-muted-foreground">Reading the defense log…</p> : null}
            {report && events.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                {filter === "all"
                  ? "Nothing has touched the console or the agent yet. Wrong tokens, scans and hostile messages will show up here."
                  : "Nothing in this view yet."}
              </div>
            ) : null}
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </CardContent>
        </Card>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Safety checks</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {(report?.checks ?? []).map((check) => (
                <Check key={check.name} check={check} />
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Locked out</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {report?.locked.length ? (
                report.locked.map((lock) => (
                  <div key={lock.ip} className="flex justify-between gap-2">
                    <span className="font-mono text-xs">{lock.ip}</span>
                    <span className="text-xs text-muted-foreground">until {when(lock.until)}</span>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">No addresses are locked out.</p>
              )}
              <p className="text-xs text-muted-foreground">
                Five wrong tokens from one address within 15 minutes blocks sign-in from it for 15 minutes.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function EventRow({ event }: { event: DefenseEvent }) {
  const where = [event.country, event.org].filter(Boolean).join(" · ")
  return (
    <article className="grid gap-1 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={severityStyle[event.severity]}>
          {event.severity}
        </Badge>
        <span className="font-medium">{kindCopy[event.kind] ?? event.kind}</span>
        {event.count > 1 ? <span className="font-mono text-xs text-muted-foreground">×{event.count}</span> : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {event.count > 1 ? `${when(event.at)} – ${when(event.last_at)}` : when(event.at)}
        </span>
      </div>
      <p className="text-muted-foreground">{event.detail}</p>
      {event.source === "network" ? (
        <p className="font-mono text-xs break-words text-muted-foreground">
          {event.ip || "unknown address"}
          {event.country_code ? ` (${event.country_code})` : ""}
          {where ? ` · ${where}` : ""}
          {event.path ? ` · ${event.method} ${event.path}` : ""}
        </p>
      ) : null}
      {event.user_agent ? (
        <p className="truncate font-mono text-[11px] text-muted-foreground/70" title={event.user_agent}>
          {event.user_agent}
        </p>
      ) : null}
    </article>
  )
}

function Check({ check }: { check: SafetyCheck }) {
  const Icon = check.state === "ok" ? CircleCheck : check.state === "warn" ? CircleAlert : CircleX
  const color = check.state === "ok" ? "text-[#63e6be]" : check.state === "warn" ? "text-honey" : "text-destructive"
  return (
    <div className="grid grid-cols-[18px_1fr] gap-2 text-sm">
      <Icon className={`mt-0.5 size-4 ${color}`} />
      <div>
        <p>{check.name}</p>
        <p className="text-xs text-muted-foreground">{check.detail}</p>
      </div>
    </div>
  )
}
