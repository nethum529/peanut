import { randomId } from "./ids.ts";

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

export interface Room {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  status: "live" | "ended";
  endedBy?: "user" | "agent";
  participants: Map<string, Participant>;
}

export interface ParticipantView {
  name: string;
  color: string;
  isHost: boolean;
  you: boolean;
}

export interface RoomStateView {
  id: string;
  title: string;
  content: string;
  status: "live" | "ended";
  you: ParticipantView;
  participants: ParticipantView[];
}

export class RoomError extends Error {
  constructor(
    readonly code: "room_not_found" | "not_a_participant" | "bad_name",
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
      you: view(you),
      participants: [...room.participants.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map(view),
    };
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
