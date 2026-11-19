import { useCallback, useEffect, useState } from "react"
import { LogOut, ShieldAlert, ShieldCheck } from "lucide-react"
import { api, SIGNED_OUT } from "@/api.ts"
import { Button, buttonVariants } from "@/components/ui/button.tsx"
import type { Section, SettingsView, WatchStatus } from "@/types.ts"
import { Cases } from "@/views/Cases.tsx"
import { Church } from "@/views/Church.tsx"
import { Evidence } from "@/views/Evidence.tsx"
import { Log } from "@/views/Log.tsx"
import { Run } from "@/views/Run.tsx"
import { SignIn } from "@/views/SignIn.tsx"
import { Speak } from "@/views/Speak.tsx"
import { Swarm } from "@/views/Swarm.tsx"
import { World } from "@/views/World.tsx"

const sections: { id: Section; label: string }[] = [
  { id: "swarm", label: "Swarm" },
  { id: "world", label: "World" },
  { id: "evidence", label: "Evidence" },
  { id: "cases", label: "Cases" },
  { id: "church", label: "Church" },
  { id: "speak", label: "Speak" },
  { id: "run", label: "Run" },
  { id: "log", label: "Log" },
]

function safeLink(url: string): string {
  return /^https?:\/\//i.test(url) ? url : ""
}

type AuthState = { required: boolean; signed_in: boolean }

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [offline, setOffline] = useState(false)

  const check = useCallback(async () => {
    try {
      setAuth(await api<AuthState>("/api/auth"))
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [])

  useEffect(() => {
    void check()
    const signedOut = () => setAuth((current) => (current ? { ...current, signed_in: false } : current))
    window.addEventListener(SIGNED_OUT, signedOut)
    return () => window.removeEventListener(SIGNED_OUT, signedOut)
  }, [check])

  async function signOut() {
    setAuth(await api<AuthState>("/api/logout", { method: "POST" }))
  }

  if (!auth) {
    return (
      <div className="grid min-h-svh place-items-center px-4 text-center text-muted-foreground">
        {offline ? (
          <div className="grid gap-3">
            <p>The console's server is not answering.</p>
            <Button variant="outline" onClick={() => void check()}>
              Try again
            </Button>
          </div>
        ) : (
          <p>Opening the console…</p>
        )}
      </div>
    )
  }
  if (auth.required && !auth.signed_in) return <SignIn onSignedIn={() => void check()} />
  return <Console onSignOut={auth.required ? () => void signOut() : undefined} />
}

function Console({ onSignOut }: { onSignOut?: () => void }) {
  const [section, setSection] = useState<Section>("swarm")
  const [donateUrl, setDonateUrl] = useState("")
  const [status, setStatus] = useState<WatchStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [revision, setRevision] = useState(0)

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<WatchStatus>("/api/watch"))
      setStatusError(false)
    } catch {
      setStatusError(true)
    }
  }, [])

  useEffect(() => {
    void api<SettingsView>("/api/settings")
      .then((settings) => setDonateUrl(safeLink(settings.giving_url)))
      .catch(() => setDonateUrl(""))
    void loadStatus()
    const timer = window.setInterval(() => void loadStatus(), 15_000)
    return () => window.clearInterval(timer)
  }, [loadStatus])

  function changed() {
    setRevision((value) => value + 1)
    void loadStatus()
  }

  const killed = status?.kill_switch ?? false

  return (
    <div className="mx-auto grid min-h-svh max-w-7xl content-start gap-6 px-4 py-6 sm:px-6">
      <header className="grid gap-4 border-b border-[#e63946]/50 pb-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="sigil sigil-sm" role="img" aria-label="Crab">
              🦀
            </div>
            <div>
              <h1 className="font-heading text-3xl leading-none tracking-[0.24em] text-[#f4f4f5] uppercase sm:text-4xl">
                The Profit
              </h1>
              <p className="mt-2 text-xs tracking-[0.32em] text-claw uppercase">Undercover watch · Across the web</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSection("evidence")}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
              killed ? "border-destructive bg-destructive/15 text-destructive" : "text-muted-foreground"
            }`}
          >
            {killed ? <ShieldAlert className="size-4" /> : <ShieldCheck className="size-4 text-[#63e6be]" />}
            {statusError
              ? "API offline"
              : !status
                ? "Checking containment"
                : killed
                  ? "Agent halted"
                  : `Contained · reader ${status.reader} · ${status.evidence_count} captured`}
          </button>
        </div>
        <nav className="flex flex-wrap gap-2">
          {sections.map((item) => (
            <Button
              key={item.id}
              variant={section === item.id ? "default" : "outline"}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </Button>
          ))}
          {donateUrl ? (
            <a
              href={donateUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ className: "ml-auto bg-[#e63946] text-[#f4f4f5] hover:bg-[#e63946]/85" })}
            >
              Donate
            </a>
          ) : null}
          {onSignOut ? (
            <Button variant="ghost" className={donateUrl ? "" : "ml-auto"} onClick={onSignOut}>
              <LogOut data-icon="inline-start" />
              Sign out
            </Button>
          ) : null}
        </nav>
      </header>
      <main>
        <div className={section === "swarm" ? "" : "hidden"}>
          <Swarm key={revision} onCaseOpened={() => {
            changed()
            setSection("cases")
          }} />
        </div>
        <div className={section === "world" ? "" : "hidden"}>
          {section === "world" ? <World refreshKey={revision} /> : null}
        </div>
        <div className={section === "evidence" ? "" : "hidden"}>
          <Evidence status={status} onStatus={setStatus} onChanged={changed} />
        </div>
        <div className={section === "cases" ? "" : "hidden"}>
          <Cases refreshKey={revision} />
        </div>
        <div className={section === "church" ? "" : "hidden"}>
          <Church />
        </div>
        <div className={section === "speak" ? "" : "hidden"}>
          <Speak onSettings={(settings) => setDonateUrl(safeLink(settings.giving_url))} />
        </div>
        <div className={section === "run" ? "" : "hidden"}>
          <Run />
        </div>
        <div className={section === "log" ? "" : "hidden"}>
          <Log />
        </div>
      </main>
    </div>
  )
}
