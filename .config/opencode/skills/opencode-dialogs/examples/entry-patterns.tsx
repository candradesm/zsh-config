/** @jsxImportSource @opentui/solid */

// ── Entry with bar (categories, tools, models) ─────────────────────
function EntryWithBar() {
  return (
    <box flexDirection="column" gap={1}>
      {entries.map((entry) => (
        <box key={entry.label} flexDirection="column" gap={1}>
          <text fg={fg}>{/* <b> for categories */}{entry.name}</text>
          <text fg={muted}>{entry.stats}</text>
          <text fg={fg}>{buildBar(entry.pct, 50)}</text>
        </box>
      ))}
    </box>
  )
}

// ── Single-line entry (numbered lists) ─────────────────────────────
function SingleLineEntry() {
  return (
    <box flexDirection="column" gap={0}>
      {entries.map((entry, i) => (
        <text key={entry.label + i} fg={fg}>
          {String(i + 1).padStart(2)}. {entry.label.padEnd(24)}{entry.value.padStart(10)} units
        </text>
      ))}
    </box>
  )
}
