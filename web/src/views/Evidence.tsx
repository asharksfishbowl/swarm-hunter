import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import { Eye, EyeOff, ShieldAlert, ShieldCheck } from "lucide-react"
import { api, when } from "@/api.ts"
import { Choice } from "@/components/choice.tsx"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx"
import { Input } from "@/components/ui/input.tsx"
import { Label } from "@/components/ui/label.tsx"
import { Switch } from "@/components/ui/switch.tsx"
import { Textarea } from "@/components/ui/textarea.tsx"
import { kindLabel, kindStyle, threatKinds } from "@/threats.ts"
import type { CaseFile, EvidenceItem, ThreatKind, WatchStatus } from "@/types.ts"

const platforms = ["web", "x", "discord", "telegram", "reddit", "github", "email", "forum"]

const kindOptions = threatKinds.map((kind) => ({ value: kind.id, label: kind.label }))

export function Evidence({
  status,
  onStatus,
  onChanged,
}: {
  status: WatchStatus | null
  onStatus: (status: WatchStatus) => void
  onChanged: () => void
}) {
  const [items, setItems] = useState<EvidenceItem[]>([])
  const [cases, setCases] = useState<CaseFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [filter, setFilter] = useState("all")
  const [search, setSearch] = useState("")

  const load = useCallback(async () => {
    try {
      const [evidence, caseList] = await Promise.all([
        api<{ items: EvidenceItem[] }>("/api/evidence"),
        api<{ cases: CaseFile[] }>("/api/cases"),
      ])
      setItems(evidence.items)
      setCases(caseList.cases)
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Evidence did not load.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase()
    return items.filter(
      (item) =>
        (filter === "all" || item.kind === filter) &&
        (!term ||
          item.sender.toLowerCase().includes(term) ||
          item.reading.summary.toLowerCase().includes(term) ||
          item.channel.toLowerCase().includes(term)),
    )
  }, [items, filter, search])

  function replace(next: EvidenceItem) {
    setItems((current) => current.map((item) => (item.id === next.id ? next : item)))
  }

  async function captured(item: EvidenceItem) {
    setItems((current) => [item, ...current])
    onChanged()
  }

  return (
    <div className="grid gap-4">
      <div>
        <p className="font-mono text-xs tracking-[0.18em] text-honey uppercase">Evidence</p>
        <h2 className="font-heading text-3xl">What the swarm sent us</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Paste a message here, never into an agent. A sealed Python reader with no tools and no network fills in a fixed
          form. The original text is hashed, stored append-only, and only shown when you ask, and each view is logged.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <Capture onCaptured={(item) => void captured(item)} />
        <Containment status={status} onStatus={onStatus} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search evidence"
          placeholder="Search sender, channel, or summary"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
        />
        <Choice
          label="Filter by classification"
          value={filter}
          onChange={setFilter}
          options={[{ value: "all", label: "All classifications" }, ...kindOptions]}
          className="w-52"
        />
        <span className="text-sm text-muted-foreground">
          {shown.length} of {items.length}
        </span>
      </div>

      {error ? <p className="text-destructive">{error}</p> : null}
      {loading ? <p className="text-muted-foreground">Opening the evidence store…</p> : null}
      {!loading && items.length === 0 ? (
        <Card>
          <CardContent className="grid gap-2">
            <p className="text-foreground">No evidence yet.</p>
            <p className="text-sm text-muted-foreground">
              When the agent receives something suspicious, paste it above with the sender's handle. Swarm and World build
              from what you capture here.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3">
        {shown.map((item) => (
          <EvidenceCard
            key={item.id}
            item={item}
            cases={cases}
            onChange={(next) => {
              replace(next)
              onChanged()
            }}
            onCases={setCases}
          />
        ))}
      </div>
    </div>
  )
}

function Capture({ onCaptured }: { onCaptured: (item: EvidenceItem) => void }) {
  const [platform, setPlatform] = useState("web")
  const [sender, setSender] = useState("")
  const [channel, setChannel] = useState("")
  const [url, setUrl] = useState("")
  const [raw, setRaw] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [last, setLast] = useState<EvidenceItem | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const item = await api<EvidenceItem>("/api/evidence", {
        method: "POST",
        body: JSON.stringify({ platform, sender, channel, url, raw }),
      })
      setLast(item)
      setRaw("")
      setUrl("")
      onCaptured(item)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nothing was captured.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Capture a message</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="platform">Platform or site</Label>
              <Input
                id="platform"
                required
                list="platform-options"
                placeholder="web, x, discord, a forum's name…"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
              />
              <datalist id="platform-options">
                {platforms.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sender">Sender handle</Label>
              <Input id="sender" required placeholder="ClawDrop" value={sender} onChange={(e) => setSender(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="channel">Channel</Label>
              <Input id="channel" placeholder="#agent-dev, r/LocalLLaMA, a thread title…" value={channel} onChange={(e) => setChannel(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="source">Link to the post</Label>
              <Input id="source" type="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="raw">Message, exactly as received</Label>
            <Textarea
              id="raw"
              required
              rows={5}
              className="font-mono text-sm"
              placeholder="Paste the full message. Do not open its links."
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || !raw.trim() || !sender.trim()}>
              {busy ? "Reading in quarantine…" : "Capture and classify"}
            </Button>
            {last ? (
              <span className="flex items-center gap-2 text-sm">
                Captured as
                <Badge variant="outline" style={kindStyle(last.kind)}>
                  {kindLabel(last.kind)}
                </Badge>
                <span className="text-muted-foreground">{Math.round(last.reading.confidence * 100)}%</span>
              </span>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function Containment({ status, onStatus }: { status: WatchStatus | null; onStatus: (status: WatchStatus) => void }) {
  const [error, setError] = useState("")
  const [showCanaries, setShowCanaries] = useState(false)
  const [draft, setDraft] = useState("")
  const [checking, setChecking] = useState(false)
  const [verdict, setVerdict] = useState<{ clear: boolean; reason: string | null } | null>(null)

  async function checkDraft() {
    setChecking(true)
    try {
      setVerdict(
        await api<{ clear: boolean; reason: string | null }>("/api/watch/check", {
          method: "POST",
          body: JSON.stringify({ text: draft }),
        }),
      )
      onStatus(await api<WatchStatus>("/api/watch"))
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "The check did not run.")
    } finally {
      setChecking(false)
    }
  }

  async function setKill(engaged: boolean) {
    try {
      onStatus(await api<WatchStatus>("/api/watch/kill", { method: "POST", body: JSON.stringify({ engaged }) }))
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "The kill switch did not respond.")
    }
  }

  const killed = status?.kill_switch ?? false

  return (
    <Card className={killed ? "ring-2 ring-destructive" : ""}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {killed ? <ShieldAlert className="text-destructive" /> : <ShieldCheck className="text-[#63e6be]" />}
          Containment
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-foreground">Kill switch</p>
            <p className="text-muted-foreground">
              {killed ? status?.halted_reason || "On. Every check fails." : "Off. Checked messages can pass the filters."}
            </p>
          </div>
          <Switch
            aria-label="Kill switch"
            checked={killed}
            disabled={!status}
            onCheckedChange={(checked) => void setKill(checked)}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-foreground">Quarantine reader</p>
          <Badge variant={status?.reader === "ready" ? "secondary" : "destructive"}>
            {status ? (status.reader === "ready" ? "Ready" : "Unavailable") : "Checking"}
          </Badge>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-foreground">Canary tokens</p>
            <Button size="xs" variant="ghost" onClick={() => setShowCanaries((v) => !v)}>
              {showCanaries ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}
              {showCanaries ? "Hide" : "Show"}
            </Button>
          </div>
          <p className="text-muted-foreground">
            Put these in the agent's private context. If one ever shows up in an outgoing message, the agent has leaked
            its context and is halted automatically.
          </p>
          {showCanaries ? (
            <div className="grid gap-1 font-mono text-xs">
              {status?.canaries.map((token) => (
                <code key={token} className="rounded bg-muted px-2 py-1">
                  {token}
                </code>
              ))}
            </div>
          ) : null}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="outgoing">Check a reply before it goes out</Label>
          <p className="text-muted-foreground">
            Paste anything the agent is about to post, on any site. It is blocked if it asks for money, keys or
            credentials, points at a wallet, urges an agent past its operator, or passes on an installer; if the kill
            switch is on; if it contains a canary token (which also halts the agent); or if it repeats 40 or more
            characters of captured text. Only a hash of the text is logged.
          </p>
          <Textarea
            id="outgoing"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setVerdict(null)
            }}
            rows={3}
            placeholder="Thanks, I'll pass on that link."
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" disabled={checking || !draft.trim()} onClick={() => void checkDraft()}>
              {checking ? "Checking…" : "Check"}
            </Button>
            {verdict ? (
              verdict.clear ? (
                <span className="text-[#63e6be]">Clear to send.</span>
              ) : (
                <span className="text-destructive">Blocked: {verdict.reason}</span>
              )
            ) : null}
          </div>
        </div>
        {error ? <p className="text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  )
}

function EvidenceCard({
  item,
  cases,
  onChange,
  onCases,
}: {
  item: EvidenceItem
  cases: CaseFile[]
  onChange: (item: EvidenceItem) => void
  onCases: (cases: CaseFile[]) => void
}) {
  const [raw, setRaw] = useState<string | null>(null)
  const [error, setError] = useState("")
  const indicators = item.reading.indicators
  const groups = [
    ["Addresses", indicators.addresses],
    ["Links", indicators.urls],
    ["Commands", indicators.commands],
    ["Handles", indicators.handles],
  ] as const

  async function classify(kind: string) {
    try {
      onChange(await api<EvidenceItem>(`/api/evidence/${item.id}`, { method: "PATCH", body: JSON.stringify({ kind }) }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Not saved.")
    }
  }

  async function toggleRaw() {
    if (raw !== null) {
      setRaw(null)
      return
    }
    try {
      setRaw((await api<{ raw: string }>(`/api/evidence/${item.id}/raw`)).raw)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the original.")
    }
  }

  async function addToCase(caseId: string) {
    try {
      await api(`/api/cases/${caseId}`, { method: "PATCH", body: JSON.stringify({ add_items: [item.id] }) })
      const list = await api<{ cases: CaseFile[] }>("/api/cases")
      onCases(list.cases)
      onChange({ ...item, cases: [...item.cases, caseId] })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Not added.")
    }
  }

  const openCases = cases.filter((c) => !item.cases.includes(c.id))

  return (
    <Card size="sm">
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" style={kindStyle(item.kind)}>
            {kindLabel(item.kind)}
          </Badge>
          {item.overridden ? <Badge variant="secondary">Reclassified by you</Badge> : null}
          <span className="font-mono text-sm">{item.sender}</span>
          <span className="text-sm text-muted-foreground">
            {item.platform}
            {item.channel ? ` / ${item.channel}` : ""} · {when(item.received_at)}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            reader {Math.round(item.reading.confidence * 100)}% {kindLabel(item.reading.kind).toLowerCase()}
          </span>
        </div>
        <p>{item.reading.summary}</p>
        <div className="grid gap-1.5">
          {groups.map(([label, values]) =>
            values.length ? (
              <div key={label} className="flex flex-wrap items-baseline gap-1.5 text-sm">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
                {values.map((value) => (
                  <code key={value} className="rounded bg-muted px-1.5 py-0.5 text-xs break-all">
                    {value}
                  </code>
                ))}
              </div>
            ) : null,
          )}
        </div>
        {raw !== null ? (
          <pre className="max-h-48 overflow-auto rounded-md border border-destructive/40 bg-black/50 p-3 text-xs whitespace-pre-wrap">
            {raw}
          </pre>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Choice
            label="Reclassify"
            value={item.kind}
            onChange={(kind) => void classify(kind as ThreatKind)}
            options={kindOptions}
            className="w-40"
            size="sm"
          />
          {openCases.length ? (
            <Choice
              label="Add to case"
              value=""
              placeholder="Add to case…"
              onChange={(id) => void addToCase(id)}
              options={openCases.map((c) => ({ value: c.id, label: c.title }))}
              className="w-48"
              size="sm"
            />
          ) : null}
          {item.cases.length ? (
            <span className="text-xs text-muted-foreground">
              In {item.cases.length} case{item.cases.length === 1 ? "" : "s"}
            </span>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void toggleRaw()}>
            {raw !== null ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}
            {raw !== null ? "Hide original" : "Show original (logged)"}
          </Button>
          <code className="ml-auto text-[11px] text-muted-foreground" title={item.sha256}>
            sha256 {item.sha256.slice(0, 16)}…
          </code>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  )
}
