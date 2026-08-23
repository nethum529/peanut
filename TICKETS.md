# Peanut build tickets (shot 1)

Rule: one ticket per branch and pull request. Keep each ticket small so
review happens before more code stacks on top. Reviewer approves before
merge.

## Done

## Queue

- T01 Scaffold: Bun monorepo layout, workspaces, tsconfig, license,
  readme, design mock moved to design/, CI-free. No feature code.
- T02 Server rooms: create room, guest join with name, session id
  cookie, color assignment, room state endpoint. Tests.
- T03 Rounds API: pin instruction, prune, flush round, agent reply,
  /api/poll long-poll with heartbeat, ended_by user vs agent. Tests.
- T04 Permissions: host grants revocable per-guest "can send to agent",
  recorded against the guest session id. Granted guests can flush.
  Verdict and grants stay host only. Tests.
- T05 Yjs relay: dumb websocket relay plus awareness for live cursors.
- T06 Web shell: serve the UI from the server, join dialog, markdown
  plan render.
- T07 Text anchors: selector plus node path plus offsets, restore after
  reload, keep drafts whose anchor can not be restored.
- T08 Stamp: element click annotation, 5-part nth-of-type selector
  capped at the first id.
- T09 Chat sidebar: round history, instruction stack, composer,
  verdict row, permissions dropdown, share button. Match design/mock.html.
- T10 CLI: `peanut <file>` blocks, long-polls, returns the review
  result as command output.
- T11 Claude Code adapter: /peanut skill definition.
- T12 Tunnel: cloudflared quick tunnel, link to clipboard.
- T13 Single binary: bun build --compile, release checklist.

Out of shot 1: live-UI Stamp reverse proxy (shot 2), vim mode, image
drawing, embedded terminal, QR codes, session archive.
