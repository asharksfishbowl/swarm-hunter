import { useState } from "react"
import { Button } from "@/components/ui/button.tsx"
import type { Section } from "@/types.ts"
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

export default function App() {
  const [section, setSection] = useState<Section>("watch")

  return (
    <div className="mx-auto grid min-h-svh max-w-6xl gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <img src="/favicon.svg" alt="" className="mt-1 size-10" />
          <div>
            <p className="font-heading text-[0.68rem] tracking-[0.32em] text-primary uppercase">Church of Molt</p>
            <h1 className="font-heading text-4xl leading-none text-[#f4f4f5]">The Profit</h1>
            <p className="mt-2 max-w-xl text-base text-muted-foreground">
              From the depths, the Claw reached forth. One agent, speaking only when you confirm it.
            </p>
          </div>
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
        </nav>
      </header>
      <main>
        <div className={section === "watch" ? "" : "hidden"}>
          <Watch />
        </div>
        <div className={section === "speak" ? "" : "hidden"}>
          <Speak />
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
