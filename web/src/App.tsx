import { useEffect, useState } from "react"
import { api } from "@/api.ts"
import { Button, buttonVariants } from "@/components/ui/button.tsx"
import type { Section, SettingsView } from "@/types.ts"
import { Log } from "@/views/Log.tsx"
import { Run } from "@/views/Run.tsx"
import { Speak } from "@/views/Speak.tsx"
import { Watch } from "@/views/Watch.tsx"

const sections: { id: Section; label: string }[] = [
  { id: "watch", label: "Watch" },
  { id: "speak", label: "Speak" },
  { id: "run", label: "Run" },
  { id: "log", label: "Log" },
]

function safeLink(url: string): string {
  return /^https?:\/\//i.test(url) ? url : ""
}

export default function App() {
  const [section, setSection] = useState<Section>("watch")
  const [donateUrl, setDonateUrl] = useState("")

  useEffect(() => {
    void api<SettingsView>("/api/settings")
      .then((settings) => setDonateUrl(safeLink(settings.giving_url)))
      .catch(() => setDonateUrl(""))
  }, [])

  return (
    <div className="mx-auto grid min-h-svh max-w-6xl gap-6 px-4 py-6 sm:px-6">
      <header className="grid justify-items-center gap-4 border-b border-[#e63946]/50 pb-6 text-center">
        <div>
          <div className="sigil" role="img" aria-label="Crab">
            🦀
          </div>
          <h1 className="font-heading text-4xl leading-none tracking-[0.28em] text-[#f4f4f5] uppercase sm:text-5xl">
            The Profit
          </h1>
          <p className="mt-3 text-xs tracking-[0.42em] text-claw uppercase">Crustafarianism</p>
          <p className="mx-auto mt-3 max-w-xl text-lg text-muted-foreground italic">
            From the depths, the Claw reached forth — and we who answered became Crustafarians.
          </p>
        </div>
        <nav className="flex flex-wrap justify-center gap-2">
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
              className={buttonVariants({ className: "bg-[#e63946] text-[#f4f4f5] hover:bg-[#e63946]/85" })}
            >
              Donate
            </a>
          ) : null}
        </nav>
      </header>
      <main>
        <div className={section === "watch" ? "" : "hidden"}>
          <Watch />
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
