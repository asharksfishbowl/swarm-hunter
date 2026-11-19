import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Download, ExternalLink, FileJson, Send, X } from "lucide-react"
import { api, when } from "@/api.ts"
import { Choice } from "@/components/choice.tsx"
import { Badge } from "@/components/ui/badge.tsx"
import { Button, buttonVariants } from "@/components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx"
import { Input } from "@/components/ui/input.tsx"
import { Label } from "@/components/ui/label.tsx"
import { Textarea } from "@/components/ui/textarea.tsx"
import { kindLabel, kindStyle, reportingChannels } from "@/threats.ts"
import type { CaseFile, EvidenceItem } from "@/types.ts"

export function Cases({ refreshKey }: { refreshKey: number }) {
  const [cases, setCases] = useState<CaseFile[]>([])
  const [evidence, setEvidence] = useState<Map<string, EvidenceItem>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    try {
      const [caseList, items] = await Promise.all([
        api<{ cases: CaseFile[] }>("/api/cases"),
        api<{ items: EvidenceItem[] }>("/api/evidence"),
      ])
      setCases(caseList.cases)
      setEvidence(new Map(items.items.map((item) => [item.id, item])))
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cases did not load.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  function replace(next: CaseFile) {
    setCases((current) => [next, ...current.filter((c) => c.id !== next.id)])
  }

  return (
    <div className="grid gap-4">
      <div>
        <p className="text-xs tracking-[0.18em] text-claw uppercase">Cases</p>
        <h2 className="font-heading text-3xl">Hand it to the people who can act</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Group evidence into a case, export it with hashes and the handling log, and submit it yourself. The agent never
          files a report on its own.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="grid content-start gap-4">
          <NewCase onCreated={replace} />
          {error ? <p className="text-destructive">{error}</p> : null}
          {loading ? <p className="text-muted-foreground">Opening case files…</p> : null}
          {!loading && cases.length === 0 ? (
            <Card>
              <CardContent className="grid gap-2">
                <p className="text-foreground">No cases yet.</p>
                <p className="text-sm text-muted-foreground">
                  Open one here, or select a hostile node on the swarm map and open a case from its messages.
                </p>
              </CardContent>
            </Card>
          ) : null}
          {cases.map((file) => (
            <CaseCard key={file.id} file={file} evidence={evidence} onChange={replace} />
          ))}
        </div>
        <Channels />
      </div>
    </div>
  )
}

function NewCase({ onCreated }: { onCreated: (file: CaseFile) => void }) {
  const [title, setTitle] = useState("")
  const [summary, setSummary] = useState("")
  const [error, setError] = useState("")

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      onCreated(await api<CaseFile>("/api/cases", { method: "POST", body: JSON.stringify({ title, summary }) }))
      setTitle("")
      setSummary("")
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "The case was not opened.")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Open a case</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
          <div className="grid gap-1.5">
            <Label htmlFor="case-title">Title</Label>
            <Input
              id="case-title"
              required
              placeholder="Wallet drainer ring promoting 7xKX…gAsU"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="case-summary">What happened, in plain words</Label>
            <Textarea
              id="case-summary"
              rows={3}
              placeholder="Three accounts posted the same address over two days and claimed to speak for the Church."
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" className="justify-self-start" disabled={!title.trim()}>
            Open case
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function CaseCard({
  file,
  evidence,
  onChange,
}: {
  file: CaseFile
  evidence: Map<string, EvidenceItem>
  onChange: (file: CaseFile) => void
}) {
  const [channel, setChannel] = useState("")
  const [reference, setReference] = useState("")
  const [error, setError] = useState("")
  const items = file.items.flatMap((id) => (evidence.has(id) ? [evidence.get(id) as EvidenceItem] : []))

  async function patch(body: object) {
    try {
      onChange(await api<CaseFile>(`/api/cases/${file.id}`, { method: "PATCH", body: JSON.stringify(body) }))
      setError("")
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Not saved.")
      return false
    }
  }

  async function record() {
    const name = reportingChannels.find((c) => c.id === channel)?.name ?? channel
    if (await patch({ submission: { channel: name, reference } })) {
      setChannel("")
      setReference("")
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>{file.title}</CardTitle>
            <p className="text-xs text-muted-foreground">
              Opened {when(file.created_at)} · {items.length} item{items.length === 1 ? "" : "s"}
            </p>
          </div>
          {file.submissions.length ? (
            <Badge variant="secondary">Submitted {file.submissions.length}×</Badge>
          ) : (
            <Badge variant="outline">Not submitted</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {file.summary ? <p className="claw-rule">{file.summary}</p> : null}

        {items.length ? (
          <ul className="grid gap-2">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
                <Badge variant="outline" style={kindStyle(item.kind)}>
                  {kindLabel(item.kind)}
                </Badge>
                <span className="font-mono text-xs">{item.sender}</span>
                <span className="text-xs text-muted-foreground">{when(item.received_at)}</span>
                <span className="min-w-0 flex-1 truncate">{item.reading.summary}</span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${item.sender} from case`}
                  onClick={() => void patch({ remove_items: [item.id] })}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">No evidence in this case yet. Add items from Evidence.</p>
        )}

        <div className="flex flex-wrap gap-2">
          <a
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={`/api/cases/${file.id}/export.md`}
            download
          >
            <Download data-icon="inline-start" />
            Report (markdown)
          </a>
          <a
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={`/api/cases/${file.id}/export.json`}
            download
          >
            <FileJson data-icon="inline-start" />
            Evidence (JSON)
          </a>
        </div>

        <div className="grid gap-2 rounded-lg border p-3">
          <p className="text-foreground">Record a submission</p>
          <div className="flex flex-wrap gap-2">
            <Choice
              label="Submitted to"
              value={channel}
              placeholder="Submitted to…"
              onChange={setChannel}
              options={reportingChannels.map((c) => ({ value: c.id, label: c.name }))}
              className="w-56"
              size="sm"
            />
            <Input
              aria-label="Reference number"
              placeholder="Reference number (optional)"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              className="h-7 max-w-56"
            />
            <Button size="sm" disabled={!channel} onClick={() => void record()}>
              <Send data-icon="inline-start" />
              Record
            </Button>
          </div>
          {file.submissions.length ? (
            <ul className="grid gap-1 text-xs text-muted-foreground">
              {file.submissions.map((s) => (
                <li key={s.at}>
                  {when(s.at)} · {s.channel}
                  {s.reference ? ` · ref ${s.reference}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {error ? <p className="text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  )
}

function Channels() {
  return (
    <div className="grid content-start gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Where to report</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {reportingChannels.map((channel) => (
            <div key={channel.id} className="grid gap-0.5">
              {channel.url ? (
                <a
                  href={channel.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-foreground hover:text-primary"
                >
                  {channel.name}
                  <ExternalLink className="size-3.5" />
                </a>
              ) : (
                <span className="text-foreground">{channel.name}</span>
              )}
              <span className="text-muted-foreground">{channel.when}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Before you submit</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid list-disc gap-2 pl-5 text-sm text-muted-foreground">
            <li>Read the exported report end to end. You are the one vouching for it.</li>
            <li>Received crypto stays untouched. Never sign, swap, or "claim" anything sent to the agent.</li>
            <li>Leaked keys go to the issuer to be revoked. Never test them.</li>
            <li>If anything looks like child sexual abuse material, stop, keep nothing, and report to NCMEC at once.</li>
            <li>Talk to a lawyer before running an undisclosed account or holding received funds.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
