import type { Anchor } from "./anchors.ts";

export interface RoundInstruction {
  words: string;
  anchor: Anchor;
  // id is the author's public handle, never the session id.
  author: { id: string; name: string; color: string; isHost: boolean };
}

export interface RoundReply {
  message: string;
  meta?: string;
  repliedAt: number;
}

export interface Round {
  number: number;
  instructions: RoundInstruction[];
  flushedBy: string;
  flushedAt: number;
  domSnapshot: string;
  nextStep: string;
  // The verdict the host attached to this flush, if any.
  verdict?: "approve" | "request_changes";
  reply?: RoundReply;
}

// What the agent's poll returns. A queued round is delivered before an
// ended state is reported, so a send-and-end still reaches the agent.
export type AgentPollResult =
  | { status: "waiting" }
  | { status: "ended"; ended_by: "user" | "agent"; verdict?: "approve" | "request_changes" | "end" }
  | {
      status: "round";
      round: number;
      instructions: RoundInstruction[];
      dom_snapshot: string;
      next_step: string;
      verdict?: "approve" | "request_changes";
      session_ended?: true;
      ended_by?: "user" | "agent";
    };
