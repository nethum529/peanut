# Peanut

Peanut is a local, browser-based, multiplayer review surface for coding
agents. An agent shares a plan or a live UI. People join by link, pin
instructions to the content, and the agent applies them in rounds.

## How it works

1. An agent shares work. Everyone joins by link.
2. The room pins instructions. Live cursors show presence.
3. The host flushes the round: skims the list, prunes, presses Send.
4. The agent works, then replies into the room for everyone.
5. The page reloads. Back to step 2, until a verdict.

An annotation is an instruction to the agent. There is no comment type.
Verdicts are Approve, Request changes, and End. Host only.

## Parts

- `packages/server`: rooms, Yjs relay, rounds API with long-poll.
- `packages/web`: the review UI.
- `packages/cli`: the `peanut` command. It blocks until the review ends.
- `packages/adapters`: thin skill and command definitions per harness.

## Development

Requires [Bun](https://bun.sh).

```
bun install
bun test
```

Distribution is by GitHub releases only. Never published to npm.

## License

MIT. Commits require a DCO `Signed-off-by` line.
