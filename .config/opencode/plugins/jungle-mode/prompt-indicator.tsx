/** @jsxImportSource @opentui/solid */

export function JunglePromptIndicator(props: { enabled: () => boolean }) {
  return (
    <box flexDirection="row" gap={1}>
      {props.enabled() ? (
        <text fg="#22c55e">
            <b>Jungle Mode</b>
          </text>
      ) : null}
    </box>
  )
}
