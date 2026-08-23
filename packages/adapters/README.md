# Peanut adapters

Thin, user-invoked definitions that let a coding agent run the
peanut CLI. The CLI does the work; an adapter only explains the
loop. Peanut never uses hooks.

## Claude Code

Copy or link the skill directory into your skills folder:

```
ln -s "$(pwd)/claude-code/peanut" ~/.claude/skills/peanut
```

Then invoke it inside Claude Code with /peanut, or ask the agent
to get its plan reviewed.

The skill expects the peanut CLI on PATH as a real executable;
the agent's shell is non-interactive, so an alias is not enough.
From this repo:

```
printf '#!/bin/sh\nexec bun %s/packages/cli/src/main.ts "$@"\n' "$(pwd)" > ~/.local/bin/peanut
chmod +x ~/.local/bin/peanut
```

## Codex and OpenCode

Not shipped yet. Both follow the same shape: a short definition
that tells the agent to run peanut share, apply each round, and
answer with peanut reply.
