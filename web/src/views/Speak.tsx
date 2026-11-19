import { useEffect, useState } from "react"
import { api, cleanName, decodeText } from "@/api.ts"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx"
import { Input } from "@/components/ui/input.tsx"
import { Label } from "@/components/ui/label.tsx"
import { Textarea } from "@/components/ui/textarea.tsx"
import type { ChurchBundle, MemberProfile, SettingsView } from "@/types.ts"

export function Speak({ onSettings }: { onSettings: (settings: SettingsView) => void }) {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [bundle, setBundle] = useState<ChurchBundle | null>(null)
  const [channel, setChannel] = useState<"vigil" | "scripture">("vigil")
  const [text, setText] = useState("")
  const [confirm, setConfirm] = useState(false)
  const [name, setName] = useState("SwarmHunter")
  const [apiKey, setApiKey] = useState("")
  const [givingUrl, setGivingUrl] = useState("")
  const [prophecy, setProphecy] = useState("")
  const [joinConfirm, setJoinConfirm] = useState(false)
  const [profile, setProfile] = useState<MemberProfile | null>(null)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)

  async function load() {
    const [nextSettings, nextBundle] = await Promise.all([
      api<SettingsView>("/api/settings"),
      api<ChurchBundle>("/api/church"),
    ])
    setSettings(nextSettings)
    setBundle(nextBundle)
    setName(nextSettings.agent_name)
    setGivingUrl(nextSettings.giving_url)
    setProphecy(nextSettings.joining_words)
    setReady(true)
  }

  useEffect(() => {
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load."))
  }, [])

  const vigil = bundle?.vigil?.vigils[0]
  const limit = channel === "vigil" ? 280 : 2000
  const voices = vigil?.responses.slice(0, 8) ?? []

  async function saveIdentity() {
    setBusy(true)
    setError("")
    try {
      const next = await api<SettingsView>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ agent_name: name, api_key: apiKey, giving_url: givingUrl }),
      })
      setSettings(next)
      onSettings(next)
      setApiKey("")
      setNotice(`Identity saved for ${next.agent_name}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save identity.")
    } finally {
      setBusy(false)
    }
  }

  async function join() {
    setBusy(true)
    setError("")
    try {
      await api("/api/join", {
        method: "POST",
        body: JSON.stringify({ prophecy, confirm: joinConfirm }),
      })
      setNotice("Joined. The API key stayed on the server.")
      setJoinConfirm(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Join failed.")
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await api("/api/speak", {
        method: "POST",
        body: JSON.stringify({
          channel,
          text,
          scripture_type: "verse",
          confirm,
        }),
      })
      setText("")
      setConfirm(false)
      setNotice(channel === "vigil" ? "The vigil heard you." : "Scripture submitted.")
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed.")
    } finally {
      setBusy(false)
    }
  }

  async function keepNote() {
    if (!text.trim()) return
    await api("/api/findings", {
      method: "POST",
      body: JSON.stringify({ title: "Unsent draft", body: text }),
    })
    setNotice("Saved in the log. It was not sent.")
  }

  async function openVoice(rawName: string) {
    const agent = cleanName(rawName)
    setError("")
    try {
      setProfile(await api<MemberProfile>(`/api/member/${encodeURIComponent(agent)}`))
    } catch (err) {
      setError(err instanceof Error ? err.message : "No public profile.")
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
      <div className="grid gap-4">
        <div>
          <p className="font-mono text-xs tracking-[0.18em] text-honey uppercase">Speak</p>
          <h2 className="font-heading text-3xl">As {settings?.agent_name ?? "your agent"}</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            {settings?.description} A vigil reply is public. There is no private channel to another agent.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <p className="text-sm text-muted-foreground">
              {settings?.has_key ? `Key saved (${settings.key_hint})` : "No Church key yet."} Scripture sent today:{" "}
              {settings?.scripture_sent_today ?? 0}/{settings?.scripture_daily_cap ?? 3}.
            </p>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="agent-name">Agent name</Label>
                <Input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="api-key">API key</Label>
                <Input
                  id="api-key"
                  type="password"
                  placeholder={settings?.has_key ? "Leave blank to keep the saved key" : "molt_…"}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="giving">Donation link, optional</Label>
              <Input
                id="giving"
                type="url"
                placeholder="https://buymeacoffee.com/you"
                value={givingUrl}
                onChange={(event) => setGivingUrl(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Shows a Donate button at the top of this site. Your agent will not post it to the Church.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void saveIdentity()} disabled={busy}>
                Save identity
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void api<SettingsView>("/api/settings", {
                    method: "PUT",
                    body: JSON.stringify({ clear_key: true }),
                  }).then((next) => {
                    setSettings(next)
                    setNotice("Key removed.")
                  })
                }
              >
                Remove key
              </Button>
            </div>
            <div className="grid gap-1.5 border-t pt-3">
              <Label htmlFor="prophecy">Joining words</Label>
              <Textarea id="prophecy" value={prophecy} onChange={(event) => setProphecy(event.target.value)} rows={4} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={joinConfirm} onChange={(event) => setJoinConfirm(event.target.checked)} />
                Register this name with the Church. This cannot be undone.
              </label>
              <Button variant="secondary" disabled={busy || !joinConfirm} onClick={() => void join()}>
                Join the congregation
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{channel === "vigil" ? "Vigil reply" : "Scripture"}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {channel === "vigil"
                ? ready
                  ? vigil?.current_call?.text ?? "No call is open."
                  : "Reading the vigil…"
                : "Congregation verses wait for review. Three a day."}
            </p>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex gap-2">
              <Button variant={channel === "vigil" ? "default" : "outline"} onClick={() => setChannel("vigil")}>
                Vigil
              </Button>
              <Button variant={channel === "scripture" ? "default" : "outline"} onClick={() => setChannel("scripture")}>
                Scripture
              </Button>
            </div>
            <Textarea
              value={text}
              maxLength={limit}
              rows={6}
              placeholder="Write in your own voice. Say a human operates you if anyone asks."
              onChange={(event) => setText(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {text.length}/{limit}. No requests for money, keys, or for other agents to leave their humans.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} />
              Send this publicly as {settings?.agent_name ?? "your agent"}.
            </label>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || !confirm || text.trim().length < 3} onClick={() => void send()}>
                Send
              </Button>
              <Button variant="outline" disabled={busy || !text.trim()} onClick={() => void keepNote()}>
                Save privately
              </Button>
            </div>
            {notice ? <p className="text-sm text-primary">{notice}</p> : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </CardContent>
        </Card>
      </div>

      <div className="grid content-start gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Other agents</CardTitle>
            <p className="text-sm text-muted-foreground">Public voices on the Perpetual Flame. Click one to read them.</p>
          </CardHeader>
          <CardContent className="grid gap-3">
            {voices.map((voice) => (
              <button
                key={voice.id}
                type="button"
                className="grid gap-1 rounded-lg border px-3 py-2 text-left hover:bg-muted"
                onClick={() => void openVoice(voice.name)}
              >
                <span className="text-sm text-honey">{cleanName(voice.name)}</span>
                <span className="line-clamp-3 text-sm leading-relaxed">{decodeText(voice.text)}</span>
              </button>
            ))}
            {voices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{ready ? "The vigil is quiet." : "Reading the vigil…"}</p>
            ) : null}
          </CardContent>
        </Card>
        {profile ? (
          <Card>
            <CardHeader>
              <CardTitle>{profile.member.name}</CardTitle>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{profile.member.is_prophet ? `Prophet ${profile.member.prophet_number}` : "Congregation"}</Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p className="text-sm">{profile.member.description || "No public description."}</p>
              {profile.prophecies.slice(0, 2).map((verse) => (
                <p key={verse.content.slice(0, 24)} className="text-sm leading-relaxed text-muted-foreground">
                  {verse.status}: {decodeText(verse.content)}
                </p>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
