import { randomId } from "./ids.ts";
import type { Anchor } from "./anchors.ts";
import type { AgentPollResult, Round, RoundInstruction } from "./rounds.ts";

export const COLOR_PALETTE = [
  "#626689",
  "#575d6d",
  "#7a7e9f",
  "#8a6f6f",
  "#6f8a77",
  "#8a856f",
] as const;

export interface Participant {
  sessionId: string;
  name: string;
  color: string;
  isHost: boolean;
  canSend: boolean;
  joinedAt: number;
}

export interface Instruction {
  id: string;
  words: string;
  anchor: Anchor;
  authorSessionId: string;
  pinnedAt: number;
}

export interface Room {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  status: "live" | "ended";
  endedBy?: "user" | "agent";
  participants: Map<string, Participant>;
  instructions: Map<string, Instruction>;
  agentToken: string;
  rounds: Round[];
  // A flushed round waits here until an agent poll takes it. Delivery is
  // destructive, so a poll that dies before writing restores it.
  pendingRound: Round | null;
}

export interface ParticipantView {
  name: string;
  color: string;
  isHost: boolean;
  you: boolean;
}

export interface InstructionView {
  id: string;
  words: string;
  anchor: Anchor;
  author: { name: string; color: string; isHost: boolean };
  mine: boolean;
  pinnedAt: number;
}

export interface RoundView {
  number: number;
  instructions: RoundInstruction[];
  flushedBy: string;
  flushedAt: number;
  nextStep: string;
  reply?: { message: string; meta?: string; repliedAt: number };
}

export interface RoomStateView {
  id: string;
  title: string;
  content: string;
  status: "live" | "ended";
  endedBy?: "user" | "agent";
  you: ParticipantView;
  participants: ParticipantView[];
  instructions: InstructionView[];
  rounds: RoundView[];
}

export class RoomError extends Error {
  constructor(
    readonly code:
      | "room_not_found"
      | "not_a_participant"
      | "bad_name"
      | "bad_instruction"
      | "instruction_not_found"
      | "not_allowed"
      | "bad_agent_token"
      | "empty_flush"
      | "room_ended"
      | "round_pending",
    message: string,
  ) {
    super(message);
  }
}

export class RoomStore {
  private rooms = new Map<string, Room>();

  createRoom(input: { title: string; content: string; hostName: string }): {
    room: Room;
    host: Participant;
  } {
    const hostName = normalizeName(input.hostName);
    const room: Room = {
      id: randomId(),
      title: input.title.trim() || "Review",
      content: input.content,
      createdAt: Date.now(),
      status: "live",
      participants: new Map(),
      instructions: new Map(),
      agentToken: randomId(),
      rounds: [],
      pendingRound: null,
    };
    const host = this.addParticipant(room, hostName, true);
    this.rooms.set(room.id, room);
    return { room, host };
  }

  getRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError("room_not_found", `no room ${roomId}`);
    return room;
  }

  // Reuses the caller's live session when the cookie still resolves, so a
  // reload does not multiply guests.
  join(roomId: string, input: { name: string; sessionId?: string }): Participant {
    const room = this.getRoom(roomId);
    if (input.sessionId) {
      const existing = room.participants.get(input.sessionId);
      if (existing) return existing;
    }
    return this.addParticipant(room, normalizeName(input.name), false);
  }

  participant(roomId: string, sessionId: string | undefined): Participant {
    const room = this.getRoom(roomId);
    const participant = sessionId ? room.participants.get(sessionId) : undefined;
    if (!participant) {
      throw new RoomError("not_a_participant", "join the room first");
    }
    return participant;
  }

  // Session ids of other participants never leave the server; they are the
  // permission handle, not a display value.
  stateFor(roomId: string, sessionId: string): RoomStateView {
    const room = this.getRoom(roomId);
    const you = this.participant(roomId, sessionId);
    const view = (p: Participant): ParticipantView => ({
      name: p.name,
      color: p.color,
      isHost: p.isHost,
      you: p.sessionId === you.sessionId,
    });
    return {
      id: room.id,
      title: room.title,
      content: room.content,
      status: room.status,
      ...(room.endedBy ? { endedBy: room.endedBy } : {}),
      you: view(you),
      participants: [...room.participants.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map(view),
      instructions: [...room.instructions.values()]
        .sort((a, b) => a.pinnedAt - b.pinnedAt)
        .map((instruction) => {
          const author = room.participants.get(instruction.authorSessionId);
          return {
            id: instruction.id,
            words: instruction.words,
            anchor: instruction.anchor,
            author: {
              name: author?.name ?? "Unknown",
              color: author?.color ?? "#747b8c",
              isHost: author?.isHost ?? false,
            },
            mine: instruction.authorSessionId === you.sessionId,
            pinnedAt: instruction.pinnedAt,
          };
        }),
      // The DOM snapshot is agent food, not a display value, so the round
      // view omits it.
      rounds: room.rounds.map((round) => ({
        number: round.number,
        instructions: round.instructions,
        flushedBy: round.flushedBy,
        flushedAt: round.flushedAt,
        nextStep: round.nextStep,
        ...(round.reply ? { reply: round.reply } : {}),
      })),
    };
  }

  pinInstruction(
    roomId: string,
    sessionId: string | undefined,
    input: { words: string; anchor: Anchor },
  ): Instruction {
    const room = this.getRoom(roomId);
    const author = this.participant(roomId, sessionId);
    const words = input.words.trim();
    if (!words || words.length > 2000) {
      throw new RoomError("bad_instruction", "instruction words must be 1 to 2000 chars");
    }
    const instruction: Instruction = {
      id: randomId(10),
      words,
      anchor: input.anchor,
      authorSessionId: author.sessionId,
      pinnedAt: Date.now(),
    };
    room.instructions.set(instruction.id, instruction);
    return instruction;
  }

  // The author can withdraw their own instruction; the host can prune any.
  removeInstruction(roomId: string, sessionId: string | undefined, instructionId: string): void {
    const room = this.getRoom(roomId);
    const remover = this.participant(roomId, sessionId);
    const instruction = room.instructions.get(instructionId);
    if (!instruction) {
      throw new RoomError("instruction_not_found", `no instruction ${instructionId}`);
    }
    if (!remover.isHost && instruction.authorSessionId !== remover.sessionId) {
      throw new RoomError("not_allowed", "only the author or the host can remove it");
    }
    room.instructions.delete(instructionId);
  }

  // Flushing takes the whole pinned list as one numbered round. Curation
  // happens before the flush by pruning, not by picking a subset here.
  flushRound(
    roomId: string,
    sessionId: string | undefined,
    input: { domSnapshot?: string; nextStep?: string },
  ): Round {
    const room = this.getRoom(roomId);
    const flusher = this.participant(roomId, sessionId);
    if (room.status === "ended") throw new RoomError("room_ended", "the session has ended");
    if (!flusher.isHost && !flusher.canSend) {
      throw new RoomError("not_allowed", "only the host or a granted guest can send to the agent");
    }
    // A flush can not overwrite an undelivered round; superseding it would
    // silently drop instructions the agent never saw.
    if (room.pendingRound) {
      throw new RoomError("round_pending", "the agent has not picked up the previous round yet");
    }
    const instructions = [...room.instructions.values()].sort((a, b) => a.pinnedAt - b.pinnedAt);
    if (instructions.length === 0) {
      throw new RoomError("empty_flush", "there are no pinned instructions to send");
    }
    const round: Round = {
      number: room.rounds.length + 1,
      instructions: instructions.map((instruction) => {
        const author = room.participants.get(instruction.authorSessionId);
        return {
          words: instruction.words,
          anchor: instruction.anchor,
          author: {
            name: author?.name ?? "Unknown",
            color: author?.color ?? "#747b8c",
            isHost: author?.isHost ?? false,
          },
        };
      }),
      flushedBy: flusher.name,
      flushedAt: Date.now(),
      domSnapshot: input.domSnapshot ?? "",
      nextStep: input.nextStep ?? "",
    };
    room.instructions.clear();
    room.rounds.push(round);
    room.pendingRound = round;
    this.wake(room.id);
    return round;
  }

  agent(roomId: string, token: string | undefined): Room {
    const room = this.getRoom(roomId);
    if (!token || token !== room.agentToken) {
      throw new RoomError("bad_agent_token", "a valid agent token is required");
    }
    return room;
  }

  // Destructive take: the caller owns delivery and must restoreRound if the
  // connection dies before the payload is written out.
  takeRound(roomId: string, token: string | undefined): AgentPollResult {
    const room = this.agent(roomId, token);
    const pending = room.pendingRound;
    if (pending) {
      room.pendingRound = null;
      return {
        status: "round",
        round: pending.number,
        instructions: pending.instructions,
        dom_snapshot: pending.domSnapshot,
        next_step: pending.nextStep,
        ...(room.status === "ended" ? { session_ended: true as const, ended_by: room.endedBy } : {}),
      };
    }
    if (room.status === "ended") {
      return { status: "ended", ended_by: room.endedBy ?? "agent" };
    }
    return { status: "waiting" };
  }

  restoreRound(roomId: string, token: string | undefined, result: AgentPollResult): void {
    const room = this.agent(roomId, token);
    if (result.status !== "round") return;
    // Only restore when nothing newer was flushed meanwhile; a newer pending
    // round supersedes the lost one.
    if (!room.pendingRound) {
      room.pendingRound = room.rounds.find((r) => r.number === result.round) ?? null;
    }
  }

  // The agent names the round it is answering; without a number the reply
  // lands on the latest round, which is only safe when no newer flush
  // happened while the agent worked.
  agentReply(
    roomId: string,
    token: string | undefined,
    message: string,
    meta?: string,
    roundNumber?: number,
  ): void {
    const room = this.agent(roomId, token);
    const trimmed = message.trim();
    if (!trimmed) throw new RoomError("bad_instruction", "a reply message is required");
    const round =
      roundNumber === undefined
        ? room.rounds[room.rounds.length - 1]
        : room.rounds.find((r) => r.number === roundNumber);
    if (!round) throw new RoomError("not_allowed", "there is no such round to reply to");
    round.reply = { message: trimmed, ...(meta ? { meta } : {}), repliedAt: Date.now() };
  }

  // A session ended by the user stays ended by the user, even if the agent
  // also ends on its way out.
  endByUser(roomId: string, sessionId: string | undefined): void {
    const room = this.getRoom(roomId);
    const ender = this.participant(roomId, sessionId);
    if (!ender.isHost) throw new RoomError("not_allowed", "only the host can end the session");
    // First end wins in both directions: an agent that already ended keeps
    // ended_by agent, and a user end is never overwritten either.
    if (room.status !== "ended") {
      room.status = "ended";
      room.endedBy = "user";
    }
    this.wake(room.id);
  }

  endByAgent(roomId: string, token: string | undefined): void {
    const room = this.agent(roomId, token);
    room.status = "ended";
    if (room.endedBy !== "user") room.endedBy = "agent";
    this.wake(room.id);
  }

  // A poll parks a waiter here; flush and end wake every waiter for the room.
  private waiters = new Map<string, Set<() => void>>();

  // Returns a handle so a caller whose own timeout fires first can drop its
  // waiter instead of leaking it until the next wake.
  changeWaiter(roomId: string, signal?: AbortSignal): { promise: Promise<void>; dispose(): void } {
    if (signal?.aborted) {
      return { promise: Promise.resolve(), dispose() {} };
    }
    let done!: () => void;
    const set = this.waiters.get(roomId) ?? new Set();
    this.waiters.set(roomId, set);
    const promise = new Promise<void>((resolve) => {
      done = () => {
        set.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
    return { promise, dispose: () => done() };
  }

  private wake(roomId: string): void {
    const set = this.waiters.get(roomId);
    if (!set) return;
    for (const done of [...set]) done();
  }

  private addParticipant(room: Room, name: string, isHost: boolean): Participant {
    const participant: Participant = {
      sessionId: randomId(),
      name,
      color: COLOR_PALETTE[room.participants.size % COLOR_PALETTE.length]!,
      isHost,
      canSend: isHost,
      joinedAt: Date.now(),
    };
    room.participants.set(participant.sessionId, participant);
    return participant;
  }
}

function normalizeName(raw: string): string {
  const name = raw.trim().slice(0, 40);
  if (!name) throw new RoomError("bad_name", "a name is required");
  return name;
}
