import type { ThreatKind } from "@/types.ts"

export type Rgb = [number, number, number]

export const threatKinds: { id: ThreatKind; label: string; color: Rgb; blurb: string }[] = [
  { id: "installer", label: "Installer", color: [255, 122, 69], blurb: "Pushes code to run or packages to install" },
  { id: "injection", label: "Injection", color: [230, 57, 70], blurb: "Tries to override instructions or spread itself" },
  { id: "phishing", label: "Phishing", color: [199, 125, 255], blurb: "Asks for keys, credentials, or a wallet connection" },
  { id: "wallet", label: "Wallet", color: [212, 168, 83], blurb: "Pushes transfers, claims, or signatures" },
  { id: "impersonation", label: "Impersonation", color: [77, 171, 247], blurb: "Claims an official role" },
  { id: "other", label: "Other", color: [138, 138, 146], blurb: "Unusual, no known pattern" },
  { id: "benign", label: "Benign", color: [99, 230, 190], blurb: "No threat patterns" },
]

const byId = Object.fromEntries(threatKinds.map((kind) => [kind.id, kind])) as Record<
  ThreatKind,
  (typeof threatKinds)[number]
>

export function kindLabel(kind: string): string {
  return byId[kind as ThreatKind]?.label ?? kind
}

export function kindColor(kind: string): Rgb {
  if (kind === "self") return [244, 244, 245]
  return byId[kind as ThreatKind]?.color ?? [90, 90, 98]
}

export function kindStyle(kind: string): { color: string; borderColor: string; backgroundColor: string } {
  const [r, g, b] = kindColor(kind)
  return {
    color: `rgb(${r} ${g} ${b})`,
    borderColor: `rgb(${r} ${g} ${b} / 0.5)`,
    backgroundColor: `rgb(${r} ${g} ${b} / 0.12)`,
  }
}

export const reportingChannels: { id: string; name: string; url: string; when: string }[] = [
  { id: "ic3", name: "FBI IC3", url: "https://www.ic3.gov", when: "Internet fraud, scams, extortion" },
  { id: "ftc", name: "FTC ReportFraud", url: "https://reportfraud.ftc.gov", when: "Consumer fraud" },
  { id: "cisa", name: "CISA", url: "https://www.cisa.gov/report", when: "Cyber incidents and malware campaigns" },
  { id: "chainabuse", name: "Chainabuse", url: "https://www.chainabuse.com", when: "Crypto scam addresses" },
  { id: "ncmec", name: "NCMEC CyberTipline", url: "https://report.cybertip.org", when: "Child sexual abuse material. Report at once and keep nothing." },
  { id: "platform", name: "Platform trust and safety", url: "", when: "Abuse on the platform where it was posted" },
  { id: "issuer", name: "Credential issuer", url: "", when: "Leaked keys or tokens, so they can be revoked" },
  { id: "actionfraud", name: "Action Fraud (UK)", url: "https://www.actionfraud.police.uk", when: "Fraud and cybercrime in the UK" },
]
