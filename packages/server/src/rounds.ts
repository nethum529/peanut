import type { Anchor } from "./anchors.ts";

export interface RoundInstruction {
  words: string;
  anchor: Anchor;
  author: { name: string; color: string; isHost: boolean };
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
  reply?: RoundReply;
}

// What the agent's poll returns. A queued round is delivered before an
// ended state is reported, so a send-and-end still reaches the agent.
export type AgentPollResult =
  | { status: "waiting" }
  | { status: "ended"; ended_by: "user" | "agent" }
  | {
      status: "round";
      round: number;
      instructions: RoundInstruction[];
      dom_snapshot: string;
      next_step: string;
      session_ended?: true;
      ended_by?: "user" | "agent";
    };
