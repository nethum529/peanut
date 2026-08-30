import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startServer, type PeanutServer } from "./http.ts";
import { COLOR_PALETTE } from "./rooms.ts";

let server: PeanutServer;

beforeEach(() => {
  server = startServer();
});

afterEach(() => {
  server.stop();
});

async function createRoom(input: Record<string, unknown> = {}) {
  const response = await fetch(`${server.url}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({
      title: "Retry review",
      content: "# Plan",
      hostName: "Nethum",
      ...input,
    }),
  });
  const body = await response.json();
  return { response, body, cookie: cookieFrom(response) };
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

async function join(roomId: string, name: string, cookie?: string) {
  const response = await fetch(`${server.url}/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: JSON.stringify({ name }),
  });
  return { response, body: await response.json(), cookie: cookieFrom(response) };
}

describe("room creation", () => {
  test("creates a room with an unguessable id and a host session", async () => {
    const { response, body, cookie } = await createRoom();
    expect(response.status).toBe(201);
    expect(body.roomId).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(body.state.you.isHost).toBe(true);
    expect(body.state.you.name).toBe("Nethum");
    expect(cookie).toContain(`peanut_${body.roomId}=`);
  });

  test("defaults contentType to markdown and rejects invalid values", async () => {
    const { body } = await createRoom();
    expect(body.state.contentType).toBe("markdown");
    const invalid = await fetch(`${server.url}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ title: "Bad", content: "x", contentType: "pdf" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "bad_instruction" });
  });
});

describe("room document", () => {
  test("renders markdown as a full page and injects one overlay stylesheet and script", async () => {
    const { body, cookie } = await createRoom({
      title: 'Plan <one>',
      content: "# Plan\n\nUse **backoff**.",
    });
    const response = await fetch(`${server.url}/api/rooms/${body.roomId}/document`, {
      headers: { cookie },
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-popups",
    );
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("<title>Plan &lt;one&gt;</title>");
    expect(html).toContain("<h1>Plan</h1>");
    expect(html).toContain("<strong>backoff</strong>");
    expect(html).toContain("body.plan");
    const planRule = html.match(/body\.plan \{([^}]*)\}/)?.[1] ?? "";
    expect(planRule).toContain("max-width: 760px");
    expect(planRule).toContain("margin: 28px auto");
    expect(planRule).toContain("padding: 32px 40px");
    expect(planRule).toContain("border: 1px solid var(--document-line)");
    expect(planRule).toContain("border-radius: 12px");
    expect(html.match(/href="\/overlay\.css"/g)).toHaveLength(1);
    expect(html.match(/src="\/overlay\.js"/g)).toHaveLength(1);
    expect(html.indexOf('href="/overlay.css"')).toBeLessThan(html.indexOf("</body>"));
  });

  test("passes HTML through and injects assets before the body close or at the end", async () => {
    const source =
      '<!doctype html><html><head><style>.x{color:red}</style></head><body><main class="x">Hello</main><script>window.answer=42</script></BODY></html>';
    const first = await createRoom({ content: source, contentType: "html" });
    expect(first.body.state.contentType).toBe("html");
    const response = await fetch(`${server.url}/api/rooms/${first.body.roomId}/document`, {
      headers: { cookie: first.cookie },
    });
    const html = await response.text();
    expect(html).toContain('<style>.x{color:red}</style>');
    expect(html).toContain("<script>window.answer=42</script>");
    expect(html).not.toContain("body.plan");
    expect(html).toContain('<link rel="stylesheet" href="/overlay.css">');
    expect(html).toContain('<script src="/overlay.js"></script>\n</body>');

    const noBody = await createRoom({ content: "<main>No body tag</main>", contentType: "html" });
    const appended = await fetch(`${server.url}/api/rooms/${noBody.body.roomId}/document`, {
      headers: { cookie: noBody.cookie },
    }).then((result) => result.text());
    expect(appended).toEndWith(
      '<main>No body tag</main>\n<link rel="stylesheet" href="/overlay.css">\n<script src="/overlay.js"></script>',
    );
  });

  test("uses the participant cookie gate", async () => {
    const { body, cookie } = await createRoom();
    const path = `${server.url}/api/rooms/${body.roomId}/document`;
    expect((await fetch(path)).status).toBe(403);
    expect(
      (await fetch(path, { headers: { cookie: `peanut_${body.roomId}=forged` } })).status,
    ).toBe(403);
    expect((await fetch(path, { headers: { cookie } })).status).toBe(200);
  });

  test("serves the overlay assets", async () => {
    const css = await fetch(`${server.url}/overlay.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    const styles = await css.text();
    expect(styles).toContain('html[data-theme="light"]');
    expect(styles).toContain(".stamp-hover");
    expect(styles).toContain(".peanut-cursor-layer");

    const script = await fetch(`${server.url}/overlay.js`);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect((await script.text()).length).toBeGreaterThan(1000);
  });
});

describe("agent content", () => {
  test("replaces changed content and only bumps the version for a change", async () => {
    const { body, cookie } = await createRoom();
    expect(body.state.contentVersion).toBe(1);

    const changed = await fetch(`${server.url}/api/rooms/${body.roomId}/agent/content`, {
      method: "PUT",
      headers: { authorization: `Bearer ${body.agentToken}` },
      body: JSON.stringify({ content: "# Current plan" }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ updated: true, contentVersion: 2 });

    const unchanged = await fetch(`${server.url}/api/rooms/${body.roomId}/agent/content`, {
      method: "PUT",
      headers: { authorization: `Bearer ${body.agentToken}` },
      body: JSON.stringify({ content: "# Current plan" }),
    });
    expect(await unchanged.json()).toEqual({ updated: false, contentVersion: 2 });

    const state = await fetch(`${server.url}/api/rooms/${body.roomId}/state`, {
      headers: { cookie },
    }).then((response) => response.json());
    expect(state.content).toBe("# Current plan");
    expect(state.contentVersion).toBe(2);
  });

  test("requires the agent token and refuses an ended room with no rounds", async () => {
    const { body, cookie } = await createRoom();
    const path = `${server.url}/api/rooms/${body.roomId}/agent/content`;
    const unauthorized = await fetch(path, {
      method: "PUT",
      body: JSON.stringify({ content: "# Refused" }),
    });
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json()).error).toBe("bad_agent_token");

    await fetch(`${server.url}/api/rooms/${body.roomId}/end`, {
      method: "POST",
      headers: { cookie },
    });
    const ended = await fetch(path, {
      method: "PUT",
      headers: { authorization: `Bearer ${body.agentToken}` },
      body: JSON.stringify({ content: "# Too late" }),
    });
    expect(ended.status).toBe(409);
    expect((await ended.json()).error).toBe("room_ended");
  });

  test("requires string content and allows an empty document", async () => {
    const { body, cookie } = await createRoom();
    const path = `${server.url}/api/rooms/${body.roomId}/agent/content`;
    for (const payload of [{}, { content: 42 }, { content: null }]) {
      const invalid = await fetch(path, {
        method: "PUT",
        headers: { authorization: `Bearer ${body.agentToken}` },
        body: JSON.stringify(payload),
      });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error).toBe("bad_instruction");
    }

    const empty = await fetch(path, {
      method: "PUT",
      headers: { authorization: `Bearer ${body.agentToken}` },
      body: JSON.stringify({ content: "" }),
    });
    expect(await empty.json()).toEqual({ updated: true, contentVersion: 2 });
    const state = await fetch(`${server.url}/api/rooms/${body.roomId}/state`, {
      headers: { cookie },
    }).then((response) => response.json());
    expect(state.content).toBe("");
  });
});

describe("guest join", () => {
  test("guest gets a session cookie, a palette color, and shows in state", async () => {
    const { body: created } = await createRoom();
    const { response, body, cookie } = await join(created.roomId, "Sam");
    expect(response.status).toBe(200);
    expect(cookie).toContain(`peanut_${created.roomId}=`);
    expect(body.you.isHost).toBe(false);
    expect(COLOR_PALETTE).toContain(body.you.color);
    expect(body.participants.map((p: { name: string }) => p.name)).toEqual(["Nethum", "Sam"]);
  });

  test("rejoining with the same cookie reuses the session", async () => {
    const { body: created } = await createRoom();
    const first = await join(created.roomId, "Sam");
    const second = await join(created.roomId, "Sam again", first.cookie);
    expect(second.body.you.name).toBe("Sam");
    expect(second.body.participants).toHaveLength(2);
  });

  test("a blank name is refused", async () => {
    const { body: created } = await createRoom();
    const { response } = await join(created.roomId, "   ");
    expect(response.status).toBe(400);
  });

  test("joining a missing room is a 404", async () => {
    const { response } = await join("nope", "Sam");
    expect(response.status).toBe(404);
  });
});

describe("hostless join", () => {
  test("reports an empty room and atomically lets only one viewer claim Host", async () => {
    const { body: created } = await createRoom({ hostless: true });
    const initial = await fetch(`${server.url}/api/rooms/${created.roomId}/state`);
    expect(initial.status).toBe(403);
    expect(await initial.json()).toMatchObject({
      error: "not_a_participant",
      participantCount: 0,
    });

    const claims = await Promise.all([
      fetch(`${server.url}/api/rooms/${created.roomId}/join`, {
        method: "POST",
        body: JSON.stringify({ claimHost: true }),
      }),
      fetch(`${server.url}/api/rooms/${created.roomId}/join`, {
        method: "POST",
        body: JSON.stringify({ claimHost: true }),
      }),
    ]);
    expect(claims.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = claims.find((response) => response.status === 200)!;
    const state = await winner.json();
    expect(state.you).toMatchObject({ name: "Host", isHost: true });
    expect(state.participants).toHaveLength(1);

    const later = await fetch(`${server.url}/api/rooms/${created.roomId}/state`);
    expect(await later.json()).toMatchObject({ participantCount: 1 });
    const guest = await join(created.roomId, "Sam");
    expect(guest.body.you).toMatchObject({ name: "Sam", isHost: false });
  });
});

describe("participant rename", () => {
  test("renames only the caller and updates existing chat authors", async () => {
    const { body: created, cookie: hostCookie } = await createRoom();
    const guest = await join(created.roomId, "Sam");
    await fetch(`${server.url}/api/rooms/${created.roomId}/instructions`, {
      method: "POST",
      headers: { cookie: hostCookie },
      body: JSON.stringify({ words: "Host note.", anchor: { type: "chat" } }),
    });
    await fetch(`${server.url}/api/rooms/${created.roomId}/flush`, {
      method: "POST",
      headers: { cookie: hostCookie },
      body: JSON.stringify({ domSnapshot: "<main></main>", nextStep: "Review." }),
    });

    const hostId = created.state.you.id as string;
    const renamed = await fetch(
      `${server.url}/api/rooms/${created.roomId}/participants/${hostId}`,
      {
        method: "PATCH",
        headers: { cookie: hostCookie },
        body: JSON.stringify({ name: "  New Host  " }),
      },
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).you.name).toBe("New Host");

    const guestView = await fetch(`${server.url}/api/rooms/${created.roomId}/state`, {
      headers: { cookie: guest.cookie },
    }).then((response) => response.json());
    expect(guestView.participants[0].name).toBe("New Host");
    expect(guestView.rounds[0].instructions[0].author.name).toBe("New Host");

    const forbidden = await fetch(
      `${server.url}/api/rooms/${created.roomId}/participants/${hostId}`,
      {
        method: "PATCH",
        headers: { cookie: guest.cookie },
        body: JSON.stringify({ name: "Not yours" }),
      },
    );
    expect(forbidden.status).toBe(403);

    const guestRename = await fetch(
      `${server.url}/api/rooms/${created.roomId}/participants/${guest.body.you.id}`,
      {
        method: "PATCH",
        headers: { cookie: guest.cookie },
        body: JSON.stringify({ name: "Samuel" }),
      },
    );
    expect(guestRename.status).toBe(200);
    expect((await guestRename.json()).you.name).toBe("Samuel");

    const capped = await fetch(
      `${server.url}/api/rooms/${created.roomId}/participants/${hostId}`,
      {
        method: "PATCH",
        headers: { cookie: hostCookie },
        body: JSON.stringify({ name: "x".repeat(50) }),
      },
    ).then((response) => response.json());
    expect(capped.you.name).toBe("x".repeat(40));
  });

  test("refuses an empty name and keeps the old name", async () => {
    const { body: created, cookie } = await createRoom();
    const hostId = created.state.you.id as string;
    const response = await fetch(
      `${server.url}/api/rooms/${created.roomId}/participants/${hostId}`,
      {
        method: "PATCH",
        headers: { cookie },
        body: JSON.stringify({ name: "   " }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "bad_name" });
    const state = await fetch(`${server.url}/api/rooms/${created.roomId}/state`, {
      headers: { cookie },
    }).then((result) => result.json());
    expect(state.you.name).toBe("Nethum");
  });
});

describe("room state", () => {
  test("requires a valid session", async () => {
    const { body: created } = await createRoom();
    const bare = await fetch(`${server.url}/api/rooms/${created.roomId}/state`);
    expect(bare.status).toBe(403);
    const forged = await fetch(`${server.url}/api/rooms/${created.roomId}/state`, {
      headers: { cookie: `peanut_${created.roomId}=forged` },
    });
    expect(forged.status).toBe(403);
  });

  test("never exposes session ids", async () => {
    const { body: created, cookie } = await createRoom();
    await join(created.roomId, "Sam");
    const response = await fetch(`${server.url}/api/rooms/${created.roomId}/state`, {
      headers: { cookie },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("sessionId");
    const state = JSON.parse(text);
    expect(state.participants).toHaveLength(2);
    expect(state.you.you).toBe(true);
  });

  test("cookies from one room do not leak into another", async () => {
    const first = await createRoom();
    const second = await createRoom();
    const response = await fetch(`${server.url}/api/rooms/${second.body.roomId}/state`, {
      headers: { cookie: first.cookie },
    });
    expect(response.status).toBe(403);
  });
});
