import type { SpoofProfile } from "../metadata/handler";
import type { Report } from "../metadata/types";
import { knownModelCount, RULES, type Contradiction } from "./rules";

export interface LintResult {
  /** 0..100. Higher means fewer internal contradictions. Not a claim of authenticity. */
  readonly score: number;
  readonly contradictions: readonly Contradiction[];
  readonly checkedModels: number;
  /** Signals that survive metadata forgery regardless of what we write. */
  readonly outOfReach: readonly string[];
}

/**
 * Scores a file for internal contradictions.
 *
 * One function, two directions. Pass a `profile` to grade a forgery you are
 * about to create; omit it to analyse a file somebody sent you. The rules are
 * identical either way — a contradiction is a contradiction regardless of who
 * produced it.
 *
 * The score measures consistency, never authenticity. Everything in
 * `outOfReach` identifies a file independently of its metadata, so a clean
 * score means "nothing here argues with itself", not "this will pass
 * examination".
 */
export function lint(report: Report, profile?: SpoofProfile): LintResult {
  const contradictions: Contradiction[] = [];

  for (const rule of RULES) {
    try {
      const hit = rule({ report, profile });
      if (hit) contradictions.push(hit);
    } catch {
      // A throwing rule must never take down the pipeline.
    }
  }

  contradictions.sort((a, b) => b.weight - a.weight);

  const penalty = contradictions.reduce((acc, c) => acc + c.weight, 0);
  const score = Math.max(0, Math.round(100 - (penalty / RULES.length) * 100));

  return {
    score,
    contradictions,
    checkedModels: knownModelCount,
    outOfReach: [
      "Quantization and Huffman tables identify the encoder that produced the image.",
      "Double-compression artifacts in the DCT coefficients survive any header edit.",
      "CFA demosaicing traces are manufacturer-specific and live in the pixels.",
      "Sensor pattern noise (PRNU) identifies the individual physical camera body.",
    ],
  };
}
