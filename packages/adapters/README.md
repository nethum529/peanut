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

The skill expects the peanut CLI on PATH. From this repo:

```
alias peanut="bun packages/cli/src/main.ts"
```

## Codex and OpenCode

Not shipped yet. Both follow the same shape: a short definition
that tells the agent to run peanut share, apply each round, and
answer with peanut reply.
