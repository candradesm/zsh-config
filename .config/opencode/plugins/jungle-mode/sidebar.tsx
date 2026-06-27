/** @jsxImportSource @opentui/solid */

export function JungleSidebar(props: { enabled: () => boolean }) {
  return (
    <box flexDirection="column" gap={0}>
      {props.enabled() ? (
        <text fg="#22c55e">
          <b>🐵 Jungle</b>
        </text>
      ) : null}
    </box>
  )
}
