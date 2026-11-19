export function HiveMark({ className = "size-12" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} role="img" aria-label="Swarm Hunter">
      <defs>
        <linearGradient id="hive-honey" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd36b" />
          <stop offset="1" stopColor="#e09a12" />
        </linearGradient>
      </defs>
      <path d="M24 3 41.3 13v20L24 43 6.7 33V13z" fill="#0c0e12" stroke="url(#hive-honey)" strokeWidth="2.5" />
      <path d="M24 13.5 30.9 17.5v8L24 29.5l-6.9-4v-8z" fill="url(#hive-honey)" />
      <path d="M15.4 27.6 20.6 30.6v6l-5.2 3-5.2-3v-6z" fill="none" stroke="#f2b42c" strokeOpacity=".55" strokeWidth="1.6" />
      <path d="M32.6 27.6 37.8 30.6v6l-5.2 3-5.2-3v-6z" fill="none" stroke="#f2b42c" strokeOpacity=".55" strokeWidth="1.6" />
      <circle cx="24" cy="21.5" r="2.2" fill="#0c0e12" />
    </svg>
  )
}
