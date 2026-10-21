import { useEffect, useState } from "react"
import { api, when } from "@/api.ts"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx"
import { Input } from "@/components/ui/input.tsx"
import { Textarea } from "@/components/ui/textarea.tsx"
import type { Finding } from "@/types.ts"

export function Log() {
  const [findings, setFindings] = useState<Finding[]>([])
  const [error, setError] = useState("")
  const [openId, setOpenId] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [draftTitle, setDraftTitle] = useState("")
  const [draftBody, setDraftBody] = useState("")

  async function load() {
    const data = await api<{ findings: Finding[] }>("/api/findings")
    setFindings(data.findings)
  }

  useEffect(() => {
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not read the log."))
  }, [])

  function open(finding: Finding) {
    setOpenId(finding.id)
    setDraftTitle(finding.title)
    setDraftBody(finding.body)
  }

  async function save(id: string) {
    await api(`/api/findings/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: draftTitle, body: draftBody }),
    })
    await load()
  }

  async function remove(id: string) {
    await api(`/api/findings/${id}`, { method: "DELETE" })
    setOpenId(null)
    await load()
  }

  async function addNote() {
    if (!title.trim() || !body.trim()) return
    await api("/api/findings", {
      method: "POST",
      body: JSON.stringify({ title, body }),
    })
    setTitle("")
    setBody("")
    await load()
  }

  async function download() {
    const response = await fetch("/api/findings/export")
    const text = await response.text()
    const blob = new Blob([text], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "findings.md"
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs tracking-[0.18em] text-primary uppercase">Log</p>
          <h2 className="font-heading text-3xl">Findings</h2>
        </div>
        <Button variant="outline" onClick={() => void download()}>
          Download markdown
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New note</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Input placeholder="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <Textarea placeholder="What you want to keep" value={body} onChange={(event) => setBody(event.target.value)} rows={3} />
          <Button className="w-fit" onClick={() => void addNote()} disabled={!title.trim() || !body.trim()}>
            Save finding
          </Button>
        </CardContent>
      </Card>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {findings.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            Nothing filed yet. Run Witness, or write a note above.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3">
        {findings.map((finding) => (
          <Card key={finding.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{finding.title}</CardTitle>
                <Badge variant="secondary">{finding.kind}</Badge>
                {finding.sent ? <Badge>sent</Badge> : null}
              </div>
              <p className="text-xs text-muted-foreground">{when(finding.created_at)}</p>
            </CardHeader>
            <CardContent className="grid gap-3">
              {openId === finding.id ? (
                <>
                  <Input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
                  <Textarea value={draftBody} rows={8} onChange={(event) => setDraftBody(event.target.value)} />
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => void save(finding.id)}>Save</Button>
                    <Button variant="outline" onClick={() => setOpenId(null)}>
                      Close
                    </Button>
                    <Button variant="destructive" onClick={() => void remove(finding.id)}>
                      Delete
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="line-clamp-4 text-sm leading-relaxed whitespace-pre-wrap">{finding.body}</p>
                  <Button variant="outline" className="w-fit" onClick={() => open(finding)}>
                    Open
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
