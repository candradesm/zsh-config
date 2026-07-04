/** @jsxImportSource @opentui/solid */

// ── Loading ────────────────────────────────────────────────────────
function LoadingState() {
  return <text fg={muted}>Loading description…</text>
}

// ── Error ──────────────────────────────────────────────────────────
function ErrorState() {
  return (
    <box flexDirection="column" gap={1}>
      <text fg={red}><b>Error Title</b></text>
      <text fg={muted}>{errorMsg()}</text>
    </box>
  )
}

// ── Empty ──────────────────────────────────────────────────────────
function EmptyState() {
  return <text fg={muted}>No data for this view.</text>
}

// ── Pre-dialog guard (no session, DB missing, etc.) ─────────────────
function GuardDialog() {
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={fg}><b>Title</b></text>
          <text fg={muted}>— Status</text>
        </box>
        <text fg={muted}>esc</text>
      </box>
      <text fg={muted}>Descriptive message.</text>
    </box>
  )
}
