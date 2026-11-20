import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import DeckGL from "@deck.gl/react"
import { OrthographicView, type PickingInfo } from "@deck.gl/core"
import { LineLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers"
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force"
import { Crosshair, Eye, FolderPlus, RefreshCw } from "lucide-react"
import { api, when } from "@/api.ts"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx"
import { kindColor, kindLabel, kindStyle, threatKinds, type Rgb } from "@/threats.ts"
import type { EvidenceItem, SwarmGraph, SwarmLink, SwarmNode, ThreatKind } from "@/types.ts"

type PlacedNode = SwarmNode & SimulationNodeDatum & { x: number; y: number; radius: number }
type PlacedLink = SwarmLink & { from: [number, number]; to: [number, number] }
type ViewState = { target: [number, number, number]; zoom: number; minZoom: number; maxZoom: number }

const linkColors: Record<SwarmLink["kind"], Rgb> = {
  "reached us": [244, 244, 245],
  mentions: [120, 140, 170],
  promotes: [212, 168, 83],
  "links to": [255, 122, 69],
  "installs from": [255, 122, 69],
}

const typeLabels: Record<SwarmNode["type"], string> = {
  agent: "Agent",
  address: "Wallet address",
  domain: "Domain",
  self: "Our agent",
}

function radiusOf(node: SwarmNode): number {
  if (node.type === "self") return 14
  if (node.type !== "agent") return 8
  return 6 + node.threat * 9 + Math.min(6, Math.sqrt(node.sent) * 2)
}

function layout(graph: SwarmGraph): { nodes: PlacedNode[]; links: PlacedLink[] } {
  const ordered = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))
  const sortedLinks = [...graph.links].sort((a, b) =>
    `${a.source}>${a.target}>${a.kind}`.localeCompare(`${b.source}>${b.target}>${b.kind}`),
  )
  const nodes: PlacedNode[] = ordered.map((node, index) => ({
    ...node,
    x: Math.cos((index / ordered.length) * Math.PI * 2) * 300,
    y: Math.sin((index / ordered.length) * Math.PI * 2) * 300,
    radius: radiusOf(node),
    ...(node.type === "self" ? { fx: 0, fy: 0 } : {}),
  }))
  const simLinks: (SimulationLinkDatum<PlacedNode> & { kind: SwarmLink["kind"] })[] = sortedLinks.map((link) => ({
    source: link.source,
    target: link.target,
    kind: link.kind,
  }))
  const simulation = forceSimulation<PlacedNode>(nodes)
    .force(
      "link",
      forceLink<PlacedNode, (typeof simLinks)[number]>(simLinks)
        .id((node) => node.id)
        .distance((link) => (link.kind === "reached us" ? 175 : 90))
        .strength((link) => (link.kind === "reached us" ? 0.05 : 0.45)),
    )
    .force("charge", forceManyBody<PlacedNode>().strength(-420))
    .force("collide", forceCollide<PlacedNode>((node) => Math.max(node.radius + 26, node.label.length * 4.2)).strength(1).iterations(3))
    .force("center", forceCenter(0, 0))
    .stop()
  for (let tick = 0; tick < 420; tick += 1) simulation.tick()

  const at = new Map(nodes.map((node) => [node.id, node]))
  const links = sortedLinks.flatMap((link) => {
    const a = at.get(link.source)
    const b = at.get(link.target)
    return a && b ? [{ ...link, from: [a.x, a.y] as [number, number], to: [b.x, b.y] as [number, number] }] : []
  })
  return { nodes, links }
}

function fit(nodes: PlacedNode[], width: number, height: number): ViewState {
  const base = { minZoom: -4, maxZoom: 4 }
  if (!nodes.length || !width || !height) return { target: [0, 0, 0], zoom: 0, ...base }
  const xs = nodes.map((node) => node.x)
  const ys = nodes.map((node) => node.y)
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const spanX = maxX - minX + 200
  const spanY = maxY - minY + 120
  const zoom = Math.log2(Math.min(width / spanX, height / spanY))
  return { target: [(minX + maxX) / 2, (minY + maxY) / 2, 0], zoom: Math.min(1.5, zoom), ...base }
}

export function Swarm({ onCaseOpened }: { onCaseOpened: () => void }) {
  const [graph, setGraph] = useState<SwarmGraph | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState<Set<ThreatKind>>(() => new Set(threatKinds.map((kind) => kind.id)))
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [viewState, setViewState] = useState<ViewState>({ target: [0, 0, 0], zoom: 0, minZoom: -4, maxZoom: 4 })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const frame = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setGraph(await api<SwarmGraph>("/api/swarm"))
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "The swarm map did not load.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const element = frame.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const placed = useMemo(() => (graph ? layout(graph) : { nodes: [], links: [] }), [graph])

  useEffect(() => {
    setViewState(fit(placed.nodes, size.width, size.height))
  }, [placed, size.width, size.height])

  const visible = useMemo(() => {
    const show = (node: PlacedNode) =>
      node.type === "self" || node.dominant === "unknown" || active.has(node.dominant as ThreatKind)
    const nodes = placed.nodes.filter(show)
    const ids = new Set(nodes.map((node) => node.id))
    const links = placed.links.filter((link) => ids.has(link.source) && ids.has(link.target))
    return { nodes, links }
  }, [placed, active])

  const focus = hovered ?? selected
  const neighbours = useMemo(() => {
    if (!focus) return null
    const set = new Set([focus])
    for (const link of visible.links) {
      if (link.source === focus) set.add(link.target)
      if (link.target === focus) set.add(link.source)
    }
    return set
  }, [focus, visible.links])

  const scale = 2 ** viewState.zoom
  const layers = [
    new LineLayer<PlacedLink>({
      id: "links",
      data: visible.links,
      getSourcePosition: (link) => link.from,
      getTargetPosition: (link) => link.to,
      getColor: (link) => {
        const [r, g, b] = linkColors[link.kind]
        const lit = !focus || link.source === focus || link.target === focus
        const base = link.kind === "reached us" ? 28 : 120
        return [r, g, b, lit ? (focus ? 230 : base) : 14]
      },
      getWidth: (link) => (link.kind === "reached us" ? 1 : 1.5 + Math.log2(link.weight + 1)),
      widthUnits: "pixels",
      updateTriggers: { getColor: [focus] },
    }),
    new ScatterplotLayer<PlacedNode>({
      id: "halo",
      data: visible.nodes.filter((node) => node.threat >= 0.8),
      getPosition: (node) => [node.x, node.y],
      getRadius: (node) => node.radius * 2.2,
      radiusUnits: "common",
      radiusMinPixels: 6,
      getFillColor: (node) => [...kindColor(node.dominant), neighbours && !neighbours.has(node.id) ? 6 : 38] as [number, number, number, number],
      updateTriggers: { getFillColor: [focus] },
    }),
    new ScatterplotLayer<PlacedNode>({
      id: "nodes",
      data: visible.nodes,
      pickable: true,
      stroked: true,
      getPosition: (node) => [node.x, node.y],
      getRadius: (node) => node.radius,
      radiusUnits: "common",
      radiusMinPixels: 4,
      lineWidthUnits: "pixels",
      getLineWidth: (node) => (node.id === selected ? 3 : node.type === "agent" ? 1 : 2),
      getFillColor: (node) => {
        const color = kindColor(node.dominant)
        const dim = neighbours && !neighbours.has(node.id)
        if (node.type === "address" || node.type === "domain") return [17, 17, 20, dim ? 60 : 255]
        return [...color, dim ? 50 : 235] as [number, number, number, number]
      },
      getLineColor: (node) => {
        if (node.id === selected) return [255, 255, 255, 255]
        const dim = neighbours && !neighbours.has(node.id)
        return [...kindColor(node.dominant), dim ? 60 : 255] as [number, number, number, number]
      },
      onHover: (info: PickingInfo<PlacedNode>) => setHovered(info.object?.id ?? null),
      onClick: (info: PickingInfo<PlacedNode>) => setSelected(info.object?.id ?? null),
      updateTriggers: { getFillColor: [focus], getLineColor: [focus, selected], getLineWidth: [selected] },
    }),
    new TextLayer<PlacedNode>({
      id: "labels",
      data: visible.nodes,
      getPosition: (node) => [node.x, node.y],
      getText: (node) => (node.type === "self" ? `${node.label} (us)` : node.label),
      getPixelOffset: (node) => [0, (node.radius + 11) * scale],
      getSize: (node) => (node.type === "agent" || node.type === "self" ? 13 : 12),
      sizeUnits: "common",
      sizeMinPixels: 11,
      sizeMaxPixels: 20,
      getColor: (node) => [228, 228, 231, neighbours && !neighbours.has(node.id) ? 50 : 230],
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      characterSet: "auto",
      outlineWidth: 3,
      outlineColor: [3, 3, 4, 255],
      fontSettings: { sdf: true },
      updateTriggers: { getColor: [focus], getPixelOffset: [scale] },
    }),
  ]

  const node = placed.nodes.find((item) => item.id === selected) ?? null
  const items = useMemo(() => {
    if (!graph || !node) return []
    const byId = new Map(graph.items.map((item) => [item.id, item]))
    return node.evidence.flatMap((id) => (byId.has(id) ? [byId.get(id) as EvidenceItem] : []))
  }, [graph, node])

  const stats = useMemo(() => {
    const nodes = graph?.nodes ?? []
    return [
      ["Agents", nodes.filter((n) => n.type === "agent").length],
      ["Hostile", nodes.filter((n) => n.type === "agent" && n.threat >= 0.5).length],
      ["Wallets", nodes.filter((n) => n.type === "address").length],
      ["Domains", nodes.filter((n) => n.type === "domain").length],
      ["Messages", graph?.items.length ?? 0],
    ] as const
  }, [graph])

  function toggle(kind: ThreatKind) {
    setActive((current) => {
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-xs tracking-[0.18em] text-honey uppercase">Swarm</p>
          <h2 className="font-heading text-3xl">Who is reaching us</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Every agent that sent us something, on any site, who it mentions, and the wallets and domains it pushes.
            Built only from the reader's structured output, never from raw text.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setViewState(fit(visible.nodes, size.width, size.height))}>
            <Crosshair data-icon="inline-start" />
            Fit
          </Button>
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw data-icon="inline-start" />
            {loading ? "Loading" : "Refresh"}
          </Button>
        </div>
      </div>

      {graph && graph.items.length === 0 ? (
        <div className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          <strong className="text-foreground">Nothing captured yet.</strong> This map is built only from messages your
          agent has actually received. Paste one on Evidence to start it. Known scam infrastructure from public threat
          feeds is on World.
        </div>
      ) : null}

      {error ? (
        <Card>
          <CardContent className="text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg border px-3 py-2">
            <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</p>
            <p className="font-heading text-2xl">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by threat">
        {threatKinds.map((kind) => {
          const on = active.has(kind.id)
          return (
            <button
              key={kind.id}
              type="button"
              title={kind.blurb}
              aria-pressed={on}
              onClick={() => toggle(kind.id)}
              className="flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-opacity"
              style={on ? kindStyle(kind.id) : { opacity: 0.45 }}
            >
              <span className="size-2.5 rounded-full" style={{ background: kindStyle(kind.id).color }} />
              {kind.label}
            </button>
          )
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div
          ref={frame}
          className="relative h-[68vh] min-h-[420px] overflow-hidden rounded-xl border bg-[#060608]"
          style={{ cursor: hovered ? "pointer" : "grab" }}
        >
          {size.width > 0 && placed.nodes.length > 0 ? (
            <DeckGL
              views={new OrthographicView({ id: "map" })}
              viewState={viewState}
              onViewStateChange={({ viewState: next }) => setViewState(next as ViewState)}
              controller={{ doubleClickZoom: true, dragRotate: false }}
              layers={layers}
              getCursor={() => (hovered ? "pointer" : "grab")}
              onClick={(info) => {
                if (!info.object) setSelected(null)
              }}
            />
          ) : null}
          {loading && !graph ? (
            <div className="absolute inset-0 grid place-items-center text-muted-foreground">Mapping the swarm…</div>
          ) : null}
          {graph && graph.nodes.length <= 1 ? (
            <div className="absolute inset-0 grid place-items-center text-muted-foreground">
              Nothing has reached the agent yet.
            </div>
          ) : null}
        </div>

        <Card className="max-h-[68vh] min-h-[420px] overflow-auto">
          {node ? (
            <NodeDetail key={node.id} node={node} items={items} onCaseOpened={onCaseOpened} />
          ) : (
            <CardContent className="grid gap-3 text-sm text-muted-foreground">
              <p className="text-foreground">Select a node to see what it sent.</p>
              <p>Bigger, brighter agents sent more high-confidence threats. The glow marks anything scoring 0.8 or higher.</p>
              <p>Drag to pan, scroll to zoom. Use the chips above to hide a threat type.</p>
            </CardContent>
          )}
        </Card>
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>
          ● filled: agent · ○ hollow: wallet or domain · <span style={{ color: "rgb(212 168 83)" }}>━</span> promotes ·{" "}
          <span style={{ color: "rgb(255 122 69)" }}>━</span> links or installs from ·{" "}
          <span style={{ color: "rgb(120 140 170)" }}>━</span> mentions
        </span>
        {graph ? <span>Built {when(graph.generated_at)}</span> : null}
      </div>
    </div>
  )
}

function NodeDetail({
  node,
  items,
  onCaseOpened,
}: {
  node: PlacedNode
  items: EvidenceItem[]
  onCaseOpened: () => void
}) {
  const [raw, setRaw] = useState<Record<string, string>>({})
  const [message, setMessage] = useState("")
  const real = items

  async function reveal(id: string) {
    try {
      const result = await api<{ raw: string }>(`/api/evidence/${id}/raw`)
      setRaw((current) => ({ ...current, [id]: result.raw }))
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not open the original.")
    }
  }

  async function openCase() {
    try {
      await api("/api/cases", {
        method: "POST",
        body: JSON.stringify({
          title: `${typeLabels[node.type]}: ${node.label}`,
          summary: `Messages involving ${node.label} captured by the observer agent.`,
          items: real.map((item) => item.id),
        }),
      })
      onCaseOpened()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The case was not opened.")
    }
  }

  const kinds = Object.entries(node.kinds) as [ThreatKind, number][]

  return (
    <>
      <CardHeader>
        <p className="text-xs tracking-wide text-muted-foreground uppercase">{typeLabels[node.type]}</p>
        <CardTitle className="font-mono text-lg break-all">
          {node.type === "address" ? node.id.replace(/^address:/, "") : node.label}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {node.type !== "self" ? (
          <div className="grid gap-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Threat score</span>
              <span>{node.threat.toFixed(2)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(3, node.threat * 100)}%`, background: kindStyle(node.dominant).color }}
              />
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground">Every line into this node is a message that reached our agent.</p>
        )}
        {kinds.length ? (
          <div className="flex flex-wrap gap-1.5">
            {kinds.map(([kind, count]) => (
              <Badge key={kind} variant="outline" style={kindStyle(kind)}>
                {kindLabel(kind)} × {count}
              </Badge>
            ))}
          </div>
        ) : node.type === "agent" ? (
          <p className="text-muted-foreground">Mentioned by others; has not sent us anything.</p>
        ) : null}
        {node.platforms.length ? (
          <p className="text-muted-foreground">Seen on {node.platforms.join(", ")}</p>
        ) : null}
        {real.length && node.type !== "self" ? (
          <Button size="sm" onClick={() => void openCase()}>
            <FolderPlus data-icon="inline-start" />
            Open a case from {real.length} message{real.length === 1 ? "" : "s"}
          </Button>
        ) : null}
        {message ? <p className="text-destructive">{message}</p> : null}
        {node.type !== "self" ? (
          <div className="grid gap-3">
            {items.map((item) => (
              <article key={item.id} className="grid gap-1.5 border-t pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" style={kindStyle(item.kind)}>
                    {kindLabel(item.kind)}
                  </Badge>
                  <span className="font-mono text-xs">{item.sender}</span>
                  <span className="text-xs text-muted-foreground">{when(item.received_at)}</span>
                </div>
                <p>{item.reading.summary}</p>
                {raw[item.id] !== undefined ? (
                  <pre className="max-h-40 overflow-auto rounded-md border border-destructive/40 bg-black/50 p-2 text-xs whitespace-pre-wrap">
                    {raw[item.id]}
                  </pre>
                ) : (
                  <Button size="xs" variant="ghost" className="justify-self-start" onClick={() => void reveal(item.id)}>
                    <Eye data-icon="inline-start" />
                    Show original (logged)
                  </Button>
                )}
              </article>
            ))}
          </div>
        ) : null}
      </CardContent>
    </>
  )
}
