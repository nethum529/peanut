---
name: peanut
description: Share a plan or document for live human review with Peanut. Starts a review room, relays the link, applies each round of instructions, and reports the final verdict.
---

# Peanut review

Peanut is a local review tool. You share a markdown file, people
join by a link, pin instructions to the text, and send them back
to you in rounds. The review ends with a verdict.

The peanut commands block until the room sends something. A human
round can take much longer than any foreground timeout, so always
run peanut with the Bash tool in background mode. Read the output
when the command finishes. Never kill a running peanut command
just because it is quiet; quiet means the room is still thinking.

## Start a review

When the user asks for a review of a file, run in the background:

```
peanut share <file>
```

Add --tunnel when a reviewer is not on this machine; the command
then also prints a public link.

The command prints the share link first. Read the partial output,
relay the link to the user right away, then wait for the command
to finish. It returns when the room sends the first round.

Never run peanut share again while a review is open. A second
share creates a new empty room and the old link dies for everyone
already in it. To continue an open review, use peanut reply.

## Apply a round

The output lists numbered instructions. Each one has an author
and the text or block of the file it points at. Apply every
instruction to the file. Then answer, again in the background:

```
peanut reply "<one short summary of what you changed>" --meta "<test or check results, optional>"
```

The reply command returns the next round. Repeat this step until
the review ends.

A round can carry a verdict line and still ask for a reply. When
the closing line prompts you to run peanut reply, the review is
still open, even if a line says Verdict: request_changes and even
if the round has no new instructions. Keep the loop going.

## The end of the review

The review is over only when the output says "== Review ended =="
or "The review has ended", or when the exit code is 1.

- Exit code 0 with verdict approve: the review passed. Tell the
  user and stop.
- Exit code 1: the review ended without approve. Tell the user
  the verdict and stop.
- Exit code 2: a usage or connection error. Show the printed
  message to the user instead of retrying. The review may still
  be open; peanut wait resumes waiting without sending anything,
  and peanut reply continues after a reply was lost.

## Rules

- Do not start a review unless the user asks for one.
- Do not edit parts of the file no instruction points at.
- Keep replies short; the room reads them in a sidebar.
