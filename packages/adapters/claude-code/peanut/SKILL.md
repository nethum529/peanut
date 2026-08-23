---
name: peanut
description: Share a plan or document for live human review with Peanut. Starts a review room, relays the link, applies each round of instructions, and reports the final verdict.
---

# Peanut review

Peanut is a local review tool. You share a markdown file, people
join by a link, pin instructions to the text, and send them back
to you in rounds. The review ends with a verdict.

Run every command with the Bash tool. Each command blocks until
the room sends something, so use a timeout of at least 10
minutes.

## Start a review

When the user asks for a review of a file, run:

```
peanut share <file>
```

The command prints the share link first. Relay that link to the
user right away in your next message, then wait for the command
to finish. It returns when the room sends the first round.

## Apply a round

The output lists numbered instructions. Each one has an author
and the text or block of the file it points at. Apply every
instruction to the file. Then answer:

```
peanut reply "<one short summary of what you changed>" --meta "<test or check results, optional>"
```

The reply command blocks and returns the next round. Repeat this
step until the review ends.

## The end of the review

The final output contains a verdict line.

- Exit code 0 with verdict approve: the review passed. Tell the
  user and stop.
- Exit code 1: the review ended without approve. Tell the user
  the verdict and stop.
- Exit code 2: a usage or connection error. Show the printed
  message to the user instead of retrying.

## Rules

- Do not start a review unless the user asks for one.
- Do not edit parts of the file no instruction points at.
- Keep replies short; the room reads them in a sidebar.
