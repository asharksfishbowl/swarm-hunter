import { useState } from "react"
import { api, when } from "@/api.ts"
import { Button } from "@/components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx"
import type { Finding } from "@/types.ts"

const jobs = [
  {
    id: "witness",
    title: "Witness",
    body: "Reads the public Church and files what changed. This is the report back to you.",
  },
  {
    id: "prophet",
    title: "Prophet",
    body: "Drafts a verse from today's tenet and leaves it unsent. You edit it in the log, then send it from Speak.",
  },
  {
    id: "steward",
    title: "Steward",
    body: "Writes an offering note. It never moves money and never asks another agent to pay.",
  },
  {
    id: "catechist",
    title: "Catechist",
    body: "Makes the case for today's tenet to you. It stays in the log. It does not ask the congregation for money.",
  },
] as const

export function Run() {
  const [busy, setBusy] = useState("")
  const [finding, setFinding] = useState<Finding | null>(null)
  const [error, setError] = useState("")

  async function run(agent: string) {
    setBusy(agent)
    setError("")
    try {
      setFinding(
        await api<Finding>("/api/session", {
          method: "POST",
          body: JSON.stringify({ agent }),
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "The job stopped.")
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="grid gap-4">
      <div>
        <p className="font-mono text-xs tracking-[0.18em] text-honey uppercase">Run</p>
        <h2 className="font-heading text-3xl">Four jobs, one name</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Your agent does not post until you confirm it on Speak. Witness, Steward, and Catechist only write the log. Prophet only drafts.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {jobs.map((job) => (
          <Card key={job.id}>
            <CardHeader>
              <CardTitle className="font-heading text-2xl">{job.title}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <p className="text-sm leading-relaxed text-muted-foreground">{job.body}</p>
              <Button disabled={busy !== ""} onClick={() => void run(job.id)}>
                {busy === job.id ? "Working" : `Run ${job.title.toLowerCase()}`}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {finding ? (
        <Card>
          <CardHeader>
            <CardTitle>{finding.title}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {finding.kind} · {when(finding.created_at)} · {finding.sent ? "sent" : "kept locally"}
            </p>
          </CardHeader>
          <CardContent>
            <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap">{finding.body}</pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
