---
name: peanut
description: Share a plan or document for live human review with Peanut. Starts a review room, relays the link, applies each round of instructions, and reports the final verdict.
---

# Peanut review

Peanut is a local review tool. You share a document, people
join by a link, pin instructions to the text, and send them back
to you in rounds. The review ends with a verdict.

The peanut commands block until the room sends something. A human
round can take much longer than any foreground timeout, so always
run peanut with the Bash tool in background mode. Read the output
when the command finishes. Never kill a running peanut command
just because it is quiet; quiet means the room is still thinking.

## Write the document

Build a structured HTML artifact by default unless the user asks for
another format. Do not deliver a wall of prose. Put the decisions,
risks, and open questions first, where reviewers will see them.

Target about 400 words of visible text. Never exceed 700 unless the
user asks for a detailed or complete document, or gives a longer
length. In those cases, this budget does not apply.

Every block must help the reviewer decide something. Cut anything that
only informs. Keep each prose paragraph to 3 sentences at most. Lead
every section with its conclusion. Put a fact that fits in a table row
there, not in a paragraph. State each point in one place only.

When the user asks for a review of content you are about to write,
share the HTML artifact. Write review artifacts under `.peanut/` in
the working directory unless the user names another location. Use
Markdown only as an explicit fallback when HTML is not practical or
the user requests Markdown.

Use sections, cards, tables, diagrams, and side-by-side comparisons to
make the content easy to scan. Prefer these structures to long
paragraphs. Choose the type, spacing, and colour on purpose so that the
document has a clear hierarchy and supports its content.

When the document describes an existing user interface, take
screenshots of the real interface and embed them in the artifact. Keep
prose for what a screenshot cannot show, such as reasoning, trade-offs,
and open questions.

Before writing HTML, run `peanut design`. For every shape the document
will contain, run `peanut playbook <id>` with that shape's ID. Use the
design direction and each playbook when you build the artifact.

## Choose the document look

Before writing a review document, choose its look in this order. Stop
at the first step that gives you a direction:

1. If the user named a look or design system, use it.
2. Inspect the project that the document is about. This may not be the
   current working directory. Match that project's design system by
   checking its theme configuration, CSS variables or design tokens,
   component library, brand assets, and existing styled pages. If the
   document previews or proposes the product's UI, render it in the
   product's own look.
3. If the first two steps give no direction, use the Peanut default
   from `peanut design`.

When you share the document, tell the user which step supplied its look
and why.

## Start a review

When the user asks for a review of a file, run in the background:

```
peanut share <file>
```

Markdown files render as a review document. Files with an `.html`
or `.htm` extension are shared as-is, including their styles and
scripts.

Treat shared HTML as trusted local input. Its scripts run in the same
sandboxed document realm as the Peanut overlay, so they can send valid
overlay protocol messages as the viewer who opened the room. Message
shape checks and server-side room permissions still apply. The iframe
and document CSP use `allow-scripts allow-forms allow-popups` without
`allow-same-origin`, so document scripts cannot read Peanut cookies or
storage and cannot call the room API with the viewer's credentials.

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

Save the file before replying. The reply sends the file's current
content to the room.

The reply command returns the next round. Repeat this step until
the review ends.

Keep the reply under 100 words. The reply shows as a chat message
in the review page. The server refuses a longer reply; if that
happens, send a shorter one.

Keep optional reply meta at or under 500 characters. The server
refuses longer meta; if that happens, shorten it and reply again.

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
