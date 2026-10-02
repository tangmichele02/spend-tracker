import { useRef, useState } from 'react'
import { money, moneyCompact } from './format.ts'

/** Round axis ceiling and step so ticks land on clean numbers. */
function niceScale(max: number, ticks = 4): { top: number; step: number } {
  if (max <= 0) return { top: 100, step: 25 }
  const rough = max / ticks
  const pow = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough)!
  return { top: Math.ceil(max / step) * step, step }
}

/** Horizontal bars with the value at the end of every row: the list is its own table. */
export function BarList({ rows }: { rows: { label: string; cents: number; color?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.cents))
  return (
    <ul className="barlist">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="label">{r.color ? <span className="cat" style={{ background: r.color }}>{r.label}</span> : r.label}</span>
          <span className="track"><span className={r.color ? 'bar tinted' : 'bar'} style={{ width: `${Math.max(0, (r.cents / max) * 100)}%`, '--c': r.color } as React.CSSProperties} /></span>
          <span className="value">{money(r.cents)}</span>
        </li>
      ))}
    </ul>
  )
}

interface Tip { x: number; y: number; title: string; lines: { key?: string; label: string; value: string }[] }

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null
  return (
    <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
      <div className="title">{tip.title}</div>
      {tip.lines.map((l) => (
        <div key={l.label} className="line">
          {l.key && <span className="key" style={{ background: `var(${l.key})` }} />}
          <span>{l.label}</span>
          <strong>{l.value}</strong>
        </div>
      ))}
    </div>
  )
}

const W = 720
const H = 240
const PAD = { top: 12, right: 16, bottom: 26, left: 52 }

/** One series of columns over ordered labels (months). */
export function Columns({ data, label }: { data: { label: string; cents: number }[]; label: string }) {
  const [tip, setTip] = useState<Tip | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const { top, step } = niceScale(Math.max(...data.map((d) => d.cents)))
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const band = innerW / data.length
  const barW = Math.min(24, band - 2)
  const y = (cents: number) => PAD.top + innerH - (Math.max(0, cents) / top) * innerH

  return (
    <div className="chart" ref={wrap} onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="tick">{moneyCompact(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = PAD.left + band * i + band / 2
          const h = PAD.top + innerH - y(d.cents)
          const r = Math.min(4, h)
          const x0 = cx - barW / 2
          const base = PAD.top + innerH
          return (
            <g key={d.label}>
              {h > 0 && (
                <path className="col" d={`M${x0},${base} V${base - h + r} Q${x0},${base - h} ${x0 + r},${base - h} H${x0 + barW - r} Q${x0 + barW},${base - h} ${x0 + barW},${base - h + r} V${base} Z`} />
              )}
              <text x={cx} y={H - 8} textAnchor="middle" className="tick">{d.label}</text>
              {/* Hit target is the whole band, not just the bar. */}
              <rect x={PAD.left + band * i} y={PAD.top} width={band} height={innerH} fill="transparent"
                onMouseMove={(e) => {
                  const box = wrap.current!.getBoundingClientRect()
                  setTip({ x: e.clientX - box.left, y: e.clientY - box.top, title: d.label, lines: [{ label, value: money(d.cents) }] })
                }} />
            </g>
          )
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  )
}

export interface LineSeries { name: string; key: string; values: number[] }

/** Lines over dates, with a legend, end labels and a crosshair tooltip. */
export function Lines({ dates, series, label }: { dates: string[]; series: LineSeries[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const all = series.flatMap((s) => s.values)
  const { top, step } = niceScale(Math.max(...all, 0))
  const right = 96
  const innerW = W - PAD.left - right
  const innerH = H - PAD.top - PAD.bottom
  const times = dates.map((d) => Date.parse(d))
  const t0 = times[0]
  const span = Math.max(1, times[times.length - 1] - t0)
  const x = (i: number) => PAD.left + (dates.length === 1 ? innerW / 2 : ((times[i] - t0) / span) * innerW)
  const y = (cents: number) => PAD.top + innerH - (Math.max(0, cents) / top) * innerH
  const short = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' })

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const box = wrap.current!.getBoundingClientRect()
    const px = ((e.clientX - box.left) / box.width) * W
    let nearest = 0
    dates.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(nearest) - px)) nearest = i })
    setHover(nearest)
    setTip({
      x: e.clientX - box.left, y: e.clientY - box.top, title: short(dates[nearest]),
      lines: series.map((s) => ({ key: s.key, label: s.name, value: money(s.values[nearest]) })),
    })
  }

  // End labels sit beside the last point; nudge apart if two lines finish close together.
  const ends = series.map((s) => ({ s, y: y(s.values[s.values.length - 1]) })).sort((a, b) => a.y - b.y)
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14

  return (
    <div className="chart" ref={wrap} onMouseLeave={() => { setHover(null); setTip(null) }}>
      <div className="legend">
        {series.map((s) => <span key={s.name}><i style={{ background: `var(${s.key})` }} />{s.name}</span>)}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - right} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="tick">{moneyCompact(t)}</text>
          </g>
        ))}
        <text x={PAD.left} y={H - 8} className="tick">{short(dates[0])}</text>
        {dates.length > 1 && <text x={W - right} y={H - 8} textAnchor="end" className="tick">{short(dates[dates.length - 1])}</text>}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} className="axis" />}
        {series.map((s) => (
          <g key={s.name}>
            <polyline fill="none" stroke={`var(${s.key})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            {(hover !== null ? [hover] : [s.values.length - 1]).map((i) => (
              <circle key={i} cx={x(i)} cy={y(s.values[i])} r={4} fill={`var(${s.key})`} className="dot" />
            ))}
          </g>
        ))}
        {ends.map(({ s, y: ly }) => (
          <text key={s.name} x={W - right + 10} y={ly + 4} className="endlabel">{moneyCompact(s.values[s.values.length - 1])}</text>
        ))}
        <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} />
      </svg>
      <Tooltip tip={tip} />
    </div>
  )
}
