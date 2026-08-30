import type { RangeAnchor, StampAnchor } from "./anchors.ts";

export interface OverlayParticipant {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  canSend: boolean;
  you: boolean;
}

export interface OverlayInstruction {
  id: string;
  words: string;
  anchor: ({ type: "chat" } | StampAnchor | RangeAnchor) & Record<string, unknown>;
  author: { name: string; color: string; isHost: boolean };
  mine: boolean;
  pinnedAt: number;
}

export interface OverlayCursor {
  participantId: string;
  x: number;
  y: number;
  stale: boolean;
}

export type ChromeToOverlayMessage =
  | {
      type: "state";
      instructions: OverlayInstruction[];
      participants: OverlayParticipant[];
      ended: boolean;
    }
  | { type: "cursors"; cursors: OverlayCursor[] }
  | { type: "theme"; theme: "dark" | "light" }
  | { type: "new-version" }
  | { type: "snapshot-request"; requestId: string };

export type OverlayToChromeMessage =
  | { type: "ready" }
  | { type: "pin"; words: string; anchor: StampAnchor | RangeAnchor }
  | { type: "unpin"; instructionId: string }
  | { type: "anchor-state"; missingInstructionIds: string[] }
  | { type: "hover"; selector: string | null }
  | { type: "cursor"; x: number; y: number }
  | { type: "cursor-leave" }
  | { type: "draft-state"; hasDraft: boolean }
  | { type: "reload-document" }
  | { type: "snapshot"; requestId: string; html: string };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function anchor(value: unknown): value is StampAnchor | RangeAnchor | { type: "chat" } {
  if (!record(value) || typeof value.type !== "string") return false;
  if (value.type === "chat") return true;
  if (value.type === "stamp") {
    return (
      typeof value.selector === "string" &&
      (value.guard === undefined || typeof value.guard === "string")
    );
  }
  return (
    value.type === "range" &&
    typeof value.selector === "string" &&
    Array.isArray(value.nodePath) &&
    value.nodePath.every(Number.isInteger) &&
    Number.isInteger(value.startOffset) &&
    Number.isInteger(value.endOffset) &&
    typeof value.quote === "string"
  );
}

function participant(value: unknown): value is OverlayParticipant {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.color === "string" &&
    typeof value.isHost === "boolean" &&
    typeof value.canSend === "boolean" &&
    typeof value.you === "boolean"
  );
}

function instruction(value: unknown): value is OverlayInstruction {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.words === "string" &&
    anchor(value.anchor) &&
    record(value.author) &&
    typeof value.author.name === "string" &&
    typeof value.author.color === "string" &&
    typeof value.author.isHost === "boolean" &&
    typeof value.mine === "boolean" &&
    typeof value.pinnedAt === "number"
  );
}

export function isChromeToOverlayMessage(value: unknown): value is ChromeToOverlayMessage {
  if (!record(value) || typeof value.type !== "string") return false;
  if (value.type === "state") {
    return (
      Array.isArray(value.instructions) &&
      value.instructions.every(instruction) &&
      Array.isArray(value.participants) &&
      value.participants.every(participant) &&
      typeof value.ended === "boolean"
    );
  }
  if (value.type === "cursors") {
    return (
      Array.isArray(value.cursors) &&
      value.cursors.every(
        (cursor) =>
          record(cursor) &&
          typeof cursor.participantId === "string" &&
          finiteUnit(cursor.x) &&
          finiteUnit(cursor.y) &&
          typeof cursor.stale === "boolean",
      )
    );
  }
  if (value.type === "theme") return value.theme === "dark" || value.theme === "light";
  if (value.type === "new-version") return true;
  return value.type === "snapshot-request" && typeof value.requestId === "string";
}

export function isOverlayToChromeMessage(value: unknown): value is OverlayToChromeMessage {
  if (!record(value) || typeof value.type !== "string") return false;
  if (value.type === "ready" || value.type === "cursor-leave" || value.type === "reload-document") {
    return true;
  }
  if (value.type === "pin") {
    return (
      typeof value.words === "string" &&
      value.words.trim().length > 0 &&
      value.words.length <= 2000 &&
      anchor(value.anchor) &&
      value.anchor.type !== "chat"
    );
  }
  if (value.type === "unpin") return typeof value.instructionId === "string";
  if (value.type === "anchor-state") {
    return (
      Array.isArray(value.missingInstructionIds) &&
      value.missingInstructionIds.every((instructionId) => typeof instructionId === "string")
    );
  }
  if (value.type === "hover") {
    return value.selector === null || typeof value.selector === "string";
  }
  if (value.type === "cursor") return finiteUnit(value.x) && finiteUnit(value.y);
  if (value.type === "draft-state") return typeof value.hasDraft === "boolean";
  return (
    value.type === "snapshot" &&
    typeof value.requestId === "string" &&
    typeof value.html === "string"
  );
}
