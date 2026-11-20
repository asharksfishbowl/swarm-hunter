import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import DeckGL from "@deck.gl/react"
import { _GlobeView as GlobeView, MapView, type PickingInfo } from "@deck.gl/core"
import { ArcLayer, GeoJsonLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from "@deck.gl/layers"
import { feature } from "topojson-client"
import type { Topology, GeometryCollection } from "topojson-specification"
import type { FeatureCollection } from "geojson"
import { DownloadCloud, Globe2, LocateFixed, Map as MapIcon, Pause, Play, RefreshCw, RotateCcw } from "lucide-react"
import countriesTopo from "world-atlas/countries-110m.json"
import { api, when } from "@/api.ts"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx"
import { kindColor, kindLabel, kindStyle } from "@/threats.ts"
import type { Feed, Intel, ThreatKind, World as WorldData, WorldAgent, WorldArc, WorldHost } from "@/types.ts"

type Mode = "globe" | "flat"
type Source = "all" | "captured" | "feeds"
type Selection = { type: "host"; id: string } | { type: "agent"; id: string } | null
type View = { longitude: number; latitude: number; zoom: number }
type PlacedHost = WorldHost & { position: [number, number] }
type PlacedAgent = WorldAgent & { at: [number, number] }

const topology = countriesTopo as unknown as Topology<{ countries: GeometryCollection }>
const land = feature(topology, topology.objects.countries) as FeatureCollection
const oceanCells: { polygon: [number, number][] }[] = []
for (let lon = -180; lon < 180; lon += 10) {
  for (let lat = -90; lat < 90; lat += 10) {
    oceanCells.push({ polygon: [[lon, lat], [lon + 10, lat], [lon + 10, lat + 10], [lon, lat + 10]] })
  }
}
const labelFont = "ui-monospace, SFMono-Regular, Menlo, monospace"

const dbCopy: Record<WorldData["database"]["status"], string> = {
  ready: "Location database ready",
  downloading: "Downloading location database",
  missing: "Location database missing",
  failed: "Location database failed",
  off: "Location lookups off",
}

function fitView(mode: Mode, width: number, height: number, center?: View): View {
  const longitude = center?.longitude ?? 10
  if (!width || !height) return { longitude, latitude: 20, zoom: 0 }
  if (mode === "globe") return { longitude, latitude: 18, zoom: Math.log2((0.8 * Math.min(width, height)) / 102) }
  return { longitude: 10, latitude: 25, zoom: Math.max(0, Math.log2(Math.min(width / 512, height / 400))) }
}

function facing(view: View, [lon, lat]: [number, number]): boolean {
  const toRad = Math.PI / 180
  const cos =
    Math.sin(lat * toRad) * Math.sin(view.latitude * toRad) +
    Math.cos(lat * toRad) * Math.cos(view.latitude * toRad) * Math.cos((lon - view.longitude) * toRad)
  return cos > 0.2
}

function declutter<T>(items: T[], zoom: number, at: (item: T) => [number, number], rank: (item: T) => number): T[] {
  const gap = 34 / Math.pow(2, zoom)
  const kept: [number, number][] = []
  return [...items]
    .sort((a, b) => rank(b) - rank(a))
    .filter((item) => {
      const [lon, lat] = at(item)
      const clash = kept.some(
        ([klon, klat]) => Math.abs(klat - lat) < gap * 0.45 && Math.abs(klon - lon) * Math.cos((lat * Math.PI) / 180) < gap,
      )
      if (!clash) kept.push([lon, lat])
      return !clash
    })
}

function spread(hosts: WorldHost[]): Map<string, [number, number]> {
  const groups = new Map<string, WorldHost[]>()
  for (const host of hosts) {
    if (host.place?.lat == null || host.place.lon == null) continue
    const key = `${host.place.lat.toFixed(1)},${host.place.lon.toFixed(1)}`
    groups.set(key, [...(groups.get(key) ?? []), host])
  }
  const out = new Map<string, [number, number]>()
  for (const group of groups.values()) {
    group.forEach((host, index) => {
      const lon = host.place?.lon ?? 0
      const lat = host.place?.lat ?? 0
      if (index === 0) {
        out.set(host.host, [lon, lat])
        return
      }
      const angle = index * 2.39996
      const radius = 0.9 * Math.sqrt(index)
      out.set(host.host, [lon + radius * Math.cos(angle), Math.max(-85, Math.min(85, lat + 0.8 * radius * Math.sin(angle)))])
    })
  }
  return out
}

export function World({ refreshKey }: { refreshKey: number }) {
  const [world, setWorld] = useState<WorldData | null>(null)
  const [loading, setLoading] = useState(true)
  const [locating, setLocating] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [source, setSource] = useState<Source>("all")
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [mode, setMode] = useState<Mode>("globe")
  const [view, setView] = useState<View>({ longitude: 10, latitude: 18, zoom: 0 })
  const [spin, setSpin] = useState(true)
  const [selected, setSelected] = useState<Selection>(null)
  const [hovered, setHovered] = useState<Selection>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const frame = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setWorld(await api<WorldData>("/api/world"))
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "The world map did not load.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    if (world?.database.status !== "downloading") return
    const timer = window.setTimeout(() => void load(), 5000)
    return () => window.clearTimeout(timer)
  }, [world, load])

  useEffect(() => {
    const element = frame.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setView((current) => fitView(mode, size.width, size.height, current))
  }, [mode, size.width, size.height])

  useEffect(() => {
    if (!spin || mode !== "globe") return
    let handle = 0
    const tick = () => {
      setView((current) => ({ ...current, longitude: ((current.longitude + 180.06) % 360) - 180 }))
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [spin, mode])

  async function locate() {
    setLocating(true)
    setNotice("")
    try {
      const next = await api<WorldData>("/api/world/locate", { method: "POST", body: JSON.stringify({ retry: true }) })
      setWorld(next)
      const placed = next.hosts.filter((h) => h.place?.status === "located").length
      setNotice(
        next.hosts.length
          ? `Placed ${placed} of ${next.hosts.length} domains.`
          : "Nothing to locate yet. Pull the threat feeds or capture a message with a link.",
      )
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookups failed.")
    } finally {
      setLocating(false)
    }
  }

  async function pullFeeds() {
    setPulling(true)
    setNotice("")
    try {
      const intel = await api<Intel>("/api/intel/refresh", { method: "POST" })
      const next = await api<WorldData>("/api/world")
      setWorld(next)
      const failed = intel.feeds.filter((feed) => feed.error && !feed.error.includes("is not set"))
      setNotice(
        `${intel.total} listed domains from ${intel.feeds.filter((f) => f.count).length} feeds.` +
          (next.pending ? ` Press Locate to place ${next.pending} new.` : "") +
          (failed.length ? ` ${failed.map((f) => f.name).join(", ")} failed.` : ""),
      )
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "The feeds did not download.")
    } finally {
      setPulling(false)
    }
  }

  function switchMode(next: Mode) {
    setMode(next)
    if (next === "flat") setSpin(false)
  }

  const shownHosts = useMemo(
    () =>
      (world?.hosts ?? []).filter((host) =>
        source === "all" ? true : source === "captured" ? host.evidence.length > 0 : host.feeds.length > 0,
      ),
    [world, source],
  )
  const positions = useMemo(() => spread(shownHosts), [shownHosts])
  const hosts = useMemo<PlacedHost[]>(
    () =>
      shownHosts.flatMap((host) => {
        const position = positions.get(host.host)
        return position ? [{ ...host, position }] : []
      }),
    [shownHosts, positions],
  )
  const agents = useMemo<PlacedAgent[]>(
    () =>
      source === "feeds"
        ? []
        : (world?.agents ?? []).flatMap((agent) =>
            agent.position ? [{ ...agent, at: [agent.position.lon, agent.position.lat] as [number, number] }] : [],
          ),
    [world, source],
  )

  const focus = hovered ?? selected
  const related = useMemo(() => {
    if (!focus || !world) return null
    const set = new Set<string>([`${focus.type}:${focus.id}`])
    for (const arc of world.arcs) {
      if ((focus.type === "agent" && arc.agent === focus.id) || (focus.type === "host" && arc.host === focus.id)) {
        set.add(`agent:${arc.agent}`)
        set.add(`host:${arc.host}`)
      }
    }
    return set
  }, [focus, world])
  const lit = (key: string) => !related || related.has(key)
  const alpha = (key: string, on: number, off: number) => (lit(key) ? on : off)
  const globe = mode === "globe"
  const visible = <T,>(items: T[], at: (item: T) => [number, number]) =>
    globe ? items.filter((item) => facing(view, at(item))) : items
  const overlay = { depthCompare: "always" as const, depthWriteEnabled: false }

  const hostLabels = declutter(
    visible(hosts, (host) => host.position),
    view.zoom,
    (host) => host.position,
    (host) => host.threat + (lit(`host:${host.host}`) && related ? 10 : 0),
  )
  const agentLabels = visible(
    agents.filter((agent) => related?.has(`agent:${agent.name}`)),
    (agent) => agent.at,
  )
  const hostLabel = (host: PlacedHost) =>
    host.place?.city ? `${host.host} · ${host.place.city.replace(/\s*\(.*\)$/, "")}` : host.host

  const layers = [
    globe
      ? new SolidPolygonLayer<(typeof oceanCells)[number]>({
          id: "ocean",
          data: oceanCells,
          getPolygon: (d) => d.polygon,
          getFillColor: [8, 10, 16],
        })
      : null,
    new GeoJsonLayer({
      id: "land",
      data: land,
      filled: true,
      stroked: true,
      wrapLongitude: !globe,
      getFillColor: [26, 26, 32],
      getLineColor: [74, 74, 86],
      lineWidthMinPixels: 0.6,
    }),
    new ArcLayer<WorldArc>({
      id: "arcs",
      data: source === "feeds" ? [] : (world?.arcs ?? []),
      getSourcePosition: (arc) => [arc.from.lon, arc.from.lat],
      getTargetPosition: (arc) => positions.get(arc.host) ?? [arc.to.lon, arc.to.lat],
      getSourceColor: (arc) => [...kindColor(arc.kind), alpha(`host:${arc.host}`, 210, 45)] as [number, number, number, number],
      getTargetColor: (arc) => [...kindColor(arc.kind), alpha(`host:${arc.host}`, 255, 45)] as [number, number, number, number],
      getWidth: (arc) => 1.5 + arc.threat * 2,
      getHeight: 0.4,
      widthUnits: "pixels",
      greatCircle: true,
      updateTriggers: { getSourceColor: [focus], getTargetColor: [focus], getTargetPosition: [positions] },
    }),
    new ScatterplotLayer<PlacedHost>({
      id: "hosts",
      data: visible(hosts, (host) => host.position),
      parameters: overlay,
      pickable: true,
      stroked: true,
      billboard: globe,
      getPosition: (host) => host.position,
      getRadius: (host) => 5 + host.threat * 7,
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      getLineWidth: (host) => (selected?.type === "host" && selected.id === host.host ? 3 : 2),
      getFillColor: (host) => [...kindColor(host.dominant), alpha(`host:${host.host}`, 70, 25)] as [number, number, number, number],
      getLineColor: (host) =>
        selected?.type === "host" && selected.id === host.host
          ? [255, 255, 255, 255]
          : ([...kindColor(host.dominant), alpha(`host:${host.host}`, 255, 90)] as [number, number, number, number]),
      onHover: (info: PickingInfo<PlacedHost>) => setHovered(info.object ? { type: "host", id: info.object.host } : null),
      onClick: (info: PickingInfo<PlacedHost>) => {
        if (info.object) {
          setSelected({ type: "host", id: info.object.host })
          setSpin(false)
        }
      },
      updateTriggers: { getFillColor: [focus], getLineColor: [focus, selected], getLineWidth: [selected] },
    }),
    new ScatterplotLayer<PlacedAgent>({
      id: "agents",
      data: visible(agents, (agent) => agent.at),
      parameters: overlay,
      pickable: true,
      stroked: true,
      billboard: globe,
      getPosition: (agent) => agent.at,
      getRadius: (agent) => 3.5 + agent.threat * 4,
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      getLineWidth: 1,
      getFillColor: (agent) => [...kindColor(agent.dominant), alpha(`agent:${agent.name}`, 240, 80)] as [number, number, number, number],
      getLineColor: (agent) =>
        selected?.type === "agent" && selected.id === agent.name ? [255, 255, 255, 255] : [3, 3, 4, 200],
      onHover: (info: PickingInfo<PlacedAgent>) => setHovered(info.object ? { type: "agent", id: info.object.name } : null),
      onClick: (info: PickingInfo<PlacedAgent>) => {
        if (info.object) {
          setSelected({ type: "agent", id: info.object.name })
          setSpin(false)
        }
      },
      updateTriggers: { getFillColor: [focus], getLineColor: [selected] },
    }),
    new TextLayer<PlacedHost>({
      id: "host-labels",
      data: globe ? [] : hostLabels,
      getPosition: (host) => host.position,
      getText: hostLabel,
      getPixelOffset: (host) => [0, 14 + host.threat * 7],
      getSize: 11,
      getColor: (host) => [228, 228, 231, alpha(`host:${host.host}`, 225, 90)],
      fontFamily: labelFont,
      characterSet: "auto",
      outlineWidth: 3,
      outlineColor: [3, 3, 4, 255],
      fontSettings: { sdf: true },
      parameters: overlay,
      updateTriggers: { getColor: [focus] },
    }),
    new TextLayer<PlacedAgent>({
      id: "agent-labels",
      data: globe ? [] : agentLabels,
      getPosition: (agent) => agent.at,
      getText: (agent) => agent.name,
      getPixelOffset: [0, -14],
      getSize: 12,
      getColor: [244, 244, 245, 255],
      fontFamily: labelFont,
      characterSet: "auto",
      outlineWidth: 3,
      outlineColor: [3, 3, 4, 255],
      fontSettings: { sdf: true },
      parameters: overlay,
    }),
  ]

  const selectedHost = selected?.type === "host" ? world?.hosts.find((h) => h.host === selected.id) : undefined
  const selectedAgent =
    selected?.type === "agent"
      ? [...(world?.agents ?? []), ...(world?.unplaced ?? [])].find((a) => a.name === selected.id)
      : undefined
  const canLocate = world?.database.status === "ready"
  const located = hosts.length
  const totalHosts = shownHosts.length
  const counts = {
    all: world?.hosts.length ?? 0,
    captured: world?.hosts.filter((h) => h.evidence.length).length ?? 0,
    feeds: world?.hosts.filter((h) => h.feeds.length).length ?? 0,
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-xs tracking-[0.18em] text-honey uppercase">World</p>
          <h2 className="font-heading text-3xl">Where the swarm lives</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Swarms post on any site, but their links point at servers somewhere on Earth. Rings are real domains: the ones
            your agent was sent, and the live phishing, wallet-drainer and malware sites listed by public threat feeds,
            placed by DNS and IP location. Dots are the agents that sent them to you, pinned beside their main server.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-lg border p-0.5" role="group" aria-label="Which domains to show">
            {(["all", "captured", "feeds"] as const).map((key) => (
              <Button key={key} size="sm" variant={source === key ? "default" : "ghost"} onClick={() => setSource(key)}>
                {key === "all" ? "All" : key === "captured" ? "Captured" : "Feeds"}
                <span className="font-mono text-[10px] opacity-70">{counts[key]}</span>
              </Button>
            ))}
          </div>
          <div className="flex rounded-lg border p-0.5" role="group" aria-label="Map projection">
            <Button size="sm" variant={globe ? "default" : "ghost"} onClick={() => switchMode("globe")}>
              <Globe2 data-icon="inline-start" />
              Globe
            </Button>
            <Button size="sm" variant={!globe ? "default" : "ghost"} onClick={() => switchMode("flat")}>
              <MapIcon data-icon="inline-start" />
              Flat
            </Button>
          </div>
          {globe ? (
            <Button size="sm" variant="outline" onClick={() => setSpin((value) => !value)} aria-label={spin ? "Stop spinning" : "Spin"}>
              {spin ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
              {spin ? "Pause" : "Spin"}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => {
              setSelected(null)
              setView(fitView(mode, size.width, size.height, view))
            }}>
            <RotateCcw data-icon="inline-start" />
            Reset
          </Button>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </div>
      </div>

      {error ? <p className="text-destructive">{error}</p> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div
          ref={frame}
          className="relative h-[68vh] min-h-[420px] overflow-hidden rounded-xl border bg-[radial-gradient(ellipse_at_center,#0d0f18,#030304_70%)]"
        >
          {world && size.width > 0 ? (
            <DeckGL
              key={mode}
              views={globe ? new GlobeView({ id: "globe", resolution: 5 }) : new MapView({ id: "flat" })}
              viewState={view}
              onViewStateChange={({ viewState }) => {
                const next = viewState as View
                setView({ longitude: next.longitude, latitude: next.latitude, zoom: next.zoom })
              }}
              onInteractionStateChange={(state) => {
                if (state.isDragging || state.isZooming) setSpin(false)
              }}
              controller={{ dragRotate: false, scrollZoom: { speed: 0.004, smooth: true }, inertia: 250 }}
              layers={layers}
              getCursor={({ isHovering, isDragging }) => (isHovering ? "pointer" : isDragging ? "grabbing" : "grab")}
              onClick={(info) => {
                if (!info.object) setSelected(null)
              }}
            >
              {globe
                ? ({ viewport }) => (
                    <div className="pointer-events-none absolute inset-0 font-mono">
                      {hostLabels.map((host) => {
                        const [x, y] = viewport.project(host.position)
                        return (
                          <span
                            key={host.host}
                            className="absolute -translate-x-1/2 text-[11px] whitespace-nowrap text-zinc-200 [text-shadow:0_0_3px_#030304,0_0_3px_#030304]"
                            style={{ left: x, top: y + 8 + host.threat * 7, opacity: lit(`host:${host.host}`) ? 0.9 : 0.35 }}
                          >
                            {hostLabel(host)}
                          </span>
                        )
                      })}
                      {agentLabels.map((agent) => {
                        const [x, y] = viewport.project(agent.at)
                        return (
                          <span
                            key={agent.name}
                            className="absolute -translate-x-1/2 -translate-y-full text-xs whitespace-nowrap text-zinc-50 [text-shadow:0_0_3px_#030304,0_0_3px_#030304]"
                            style={{ left: x, top: y - 8 }}
                          >
                            {agent.name}
                          </span>
                        )
                      })}
                    </div>
                  )
                : null}
            </DeckGL>
          ) : null}
          {loading && !world ? (
            <div className="absolute inset-0 grid place-items-center text-muted-foreground">Drawing the world…</div>
          ) : null}
          {world && !loading && totalHosts === 0 ? (
            <div className="pointer-events-none absolute inset-x-0 top-6 px-6 text-center text-sm text-muted-foreground">
              {source === "captured"
                ? "None of the captured messages contain links yet."
                : "No feed data yet. Press Pull threat feeds to download today's lists."}
            </div>
          ) : world && !loading && totalHosts > 0 && located === 0 ? (
            <div className="pointer-events-none absolute inset-x-0 top-6 px-6 text-center text-sm text-muted-foreground">
              {totalHosts} domains are waiting to be placed. Press Locate.
            </div>
          ) : null}
          <div className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-muted-foreground/80">
            {world?.database.attribution} · Borders: Natural Earth
            {world?.intel.feeds.some((f) => f.count) ? ` · Feeds: ${world.intel.feeds.filter((f) => f.count).map((f) => f.name).join(", ")}` : ""}
          </div>
        </div>

        <Card className="max-h-[68vh] min-h-[420px] overflow-auto">
          {selectedHost ? (
            <HostDetail
              host={selectedHost}
              feeds={world?.intel.feeds ?? []}
              onAgent={(name) => setSelected({ type: "agent", id: name })}
            />
          ) : selectedAgent ? (
            <AgentDetail agent={selectedAgent} onHost={(host) => setSelected({ type: "host", id: host })} />
          ) : (
            <>
              <CardHeader>
                <CardTitle>Infrastructure by country</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {located} of {totalHosts} domains placed · {world ? dbCopy[world.database.status] : "Loading"}
                </p>
              </CardHeader>
              <CardContent className="grid gap-4 text-sm">
                {world ? (
                  <div className="grid gap-2 rounded-lg border p-3">
                    <Button size="sm" onClick={() => void locate()} disabled={!canLocate || locating}>
                      <LocateFixed data-icon="inline-start" />
                      {locating ? "Looking up…" : world.pending ? `Locate ${world.pending} new domain${world.pending === 1 ? "" : "s"}` : "Locate infrastructure"}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Looks up each domain's DNS and matches the address to a local location database. Nothing is
                      fetched from the domains themselves, though their DNS servers can see the lookup.
                    </p>
                    {notice ? <p className="text-xs text-[#63e6be]">{notice}</p> : null}
                    {world.database.note ? <p className="text-xs text-muted-foreground">{world.database.note}</p> : null}
                  </div>
                ) : null}
                {world ? <Feeds feeds={world.intel.feeds} pulling={pulling} onPull={() => void pullFeeds()} /> : null}
                {world?.countries.length ? (
                  <ul className="grid gap-2">
                    {world.countries.map((country) => (
                      <li key={country.code} className="grid gap-1">
                        <div className="flex justify-between gap-2">
                          <span>
                            <span className="font-mono text-xs text-muted-foreground">{country.code}</span> {country.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {country.hosts} domain{country.hosts === 1 ? "" : "s"} · {country.agents} agent{country.agents === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-[#f2b42c]"
                            style={{ width: `${Math.max(4, country.threat * 100)}%` }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : world ? (
                  <p className="text-muted-foreground">No domains have been placed yet.</p>
                ) : null}
                {world?.unplaced.length ? (
                  <div className="grid gap-2 border-t pt-3">
                    <p className="text-foreground">Not on the map ({world.unplaced.length})</p>
                    <p className="text-xs text-muted-foreground">
                      These agents sent nothing that points at a server we could place, such as wallet-only scams or
                      plain-text prompt worms.
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {world.unplaced.map((agent) => (
                        <button key={agent.name} type="button" onClick={() => setSelected({ type: "agent", id: agent.name })}>
                          <Badge variant="outline" style={kindStyle(agent.dominant)}>
                            {agent.name}
                          </Badge>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {world ? <p className="text-xs text-muted-foreground">Built {when(world.generated_at)}</p> : null}
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}

function Kinds({ kinds }: { kinds: Partial<Record<ThreatKind, number>> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(Object.entries(kinds) as [ThreatKind, number][]).map(([kind, count]) => (
        <Badge key={kind} variant="outline" style={kindStyle(kind)}>
          {kindLabel(kind)} × {count}
        </Badge>
      ))}
    </div>
  )
}

function Threat({ value, kind }: { value: number; kind: string }) {
  return (
    <div className="grid gap-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Threat score</span>
        <span>{value.toFixed(2)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${Math.max(3, value * 100)}%`, background: kindStyle(kind).color }} />
      </div>
    </div>
  )
}

function Feeds({ feeds, pulling, onPull }: { feeds: Feed[]; pulling: boolean; onPull: () => void }) {
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <Button size="sm" variant="outline" onClick={onPull} disabled={pulling}>
        <DownloadCloud data-icon="inline-start" />
        {pulling ? "Downloading lists…" : "Pull threat feeds"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Downloads public blocklists of live scam sites. Only the lists are fetched; the listed sites are never opened.
        Refreshes on its own every six hours.
      </p>
      <ul className="grid gap-2">
        {feeds.map((feed) => (
          <li key={feed.id} className="grid gap-0.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <a href={feed.home} target="_blank" rel="noreferrer" className="text-foreground underline-offset-2 hover:underline">
                {feed.name}
              </a>
              <Badge variant="outline" style={kindStyle(feed.kind)}>
                {feed.count} {kindLabel(feed.kind).toLowerCase()}
              </Badge>
            </div>
            <span className="text-muted-foreground">{feed.about}</span>
            {feed.error ? (
              <span className={feed.error.includes("is not set") ? "text-muted-foreground" : "text-destructive"}>
                {feed.error}
              </span>
            ) : feed.fetched_at ? (
              <span className="text-muted-foreground">Updated {when(feed.fetched_at)}</span>
            ) : (
              <span className="text-muted-foreground">Not downloaded yet</span>
            )}
            <span className="text-muted-foreground/70">{feed.license}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function HostDetail({ host, feeds, onAgent }: { host: WorldHost; feeds: Feed[]; onAgent: (name: string) => void }) {
  const place = host.place
  const rows: [string, string][] = place
    ? [
        ["Address", place.ips.slice(0, 3).join("\n") || "—"],
        ["Location", [place.city, place.country].filter(Boolean).join(", ") || "Unknown"],
        ["Network", place.asn ? `AS${place.asn} ${place.org}` : place.org || "Unknown"],
        ["Looked up", when(place.resolved_at)],
      ]
    : []
  return (
    <>
      <CardHeader>
        <p className="text-xs tracking-wide text-muted-foreground uppercase">Domain</p>
        <CardTitle className="font-mono text-lg break-all">{host.host}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <Threat value={host.threat} kind={host.dominant} />
        <Kinds kinds={host.kinds} />
        {place ? (
          <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-mono text-xs break-words whitespace-pre-line">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground">Not looked up yet.</p>
        )}
        {place && /cloudflare|amazon|google|microsoft|fastly|akamai|vercel|netlify|github/i.test(place.org) ? (
          <p className="text-muted-foreground">
            This sits behind a shared host or CDN, so the pin marks {place.org.replace(/,? Inc\.?$/, "")}'s network, not
            the operator. Report it to {place.org.replace(/,? Inc\.?$/, "")}, which can take it down.
          </p>
        ) : null}
        {place && place.status !== "located" ? (
          <p className="text-muted-foreground">
            {place.status === "unresolved"
              ? "The domain did not resolve. It may be down, sinkholed, or never registered."
              : place.status === "private"
                ? "The domain points at a private or reserved address."
                : "The address is not in the location database."}
          </p>
        ) : null}
        {host.listings.length ? (
          <div className="grid gap-2">
            <p className="text-xs text-muted-foreground">Listed by</p>
            {host.listings.map((listing) => (
              <div key={`${listing.source}-${listing.url}`} className="grid gap-0.5 rounded-md border p-2 text-xs">
                <div className="flex justify-between gap-2">
                  <a href={listing.reference} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                    {feeds.find((f) => f.id === listing.source)?.name ?? listing.source}
                  </a>
                  <span className="text-muted-foreground">{listing.listed}</span>
                </div>
                <span className="font-mono break-all text-muted-foreground select-all">{listing.url}</span>
                {listing.tags.length ? <span className="text-muted-foreground">{listing.tags.join(", ")}</span> : null}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">The listed address is shown as text only. Do not open it.</p>
          </div>
        ) : null}
        {host.senders.length ? (
          <div className="grid gap-1.5">
            <p className="text-xs text-muted-foreground">Pushed by</p>
            <div className="flex flex-wrap gap-1.5">
              {host.senders.map((name) => (
                <Button key={name} size="xs" variant="outline" onClick={() => onAgent(name)}>
                  {name}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        {host.evidence.length ? (
          <p className="text-muted-foreground">
            Seen on {host.platforms.join(", ")} in {host.evidence.length} message{host.evidence.length === 1 ? "" : "s"}.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Hosting providers take abuse reports. Add the network above to the case when you report.
        </p>
      </CardContent>
    </>
  )
}

function AgentDetail({ agent, onHost }: { agent: WorldAgent; onHost: (host: string) => void }) {
  return (
    <>
      <CardHeader>
        <p className="text-xs tracking-wide text-muted-foreground uppercase">Agent</p>
        <CardTitle className="font-mono text-lg break-all">{agent.name}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <Threat value={agent.threat} kind={agent.dominant} />
        <Kinds kinds={agent.kinds} />
        <p className="text-muted-foreground">
          Seen on {agent.platforms.join(", ")} in {agent.evidence.length} message{agent.evidence.length === 1 ? "" : "s"}.
        </p>
        <p className="text-muted-foreground">
          {agent.pinned_to
            ? `Pinned beside ${agent.pinned_to}, the most dangerous server it pushes. Where the agent itself runs is unknown.`
            : "Not on the map: nothing it sent points at a server we could place."}
        </p>
        {agent.hosts.length ? (
          <div className="grid gap-1.5">
            <p className="text-xs text-muted-foreground">Infrastructure it pushes</p>
            <div className="flex flex-wrap gap-1.5">
              {agent.hosts.map((host) => (
                <Button key={host} size="xs" variant="outline" className="font-mono" onClick={() => onHost(host)}>
                  {host}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </>
  )
}
