/**
 * vote.js — Submit answers (vote YES/NO) on Reality.eth questions
 *
 * Implements FR-7: bond recommendation, max_previous protection, submitAnswer call.
 */
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm";
import { getRealitioContract } from "./contracts.js";
import { ANSWER_YES, ANSWER_NO } from "./config.js";

/**
 * Submit an answer to a Reality.eth question.
 *
 * @param {ethers.Signer} signer - Connected wallet signer
 * @param {string} questionId - bytes32 question ID
 * @param {boolean} answerYes - true for YES, false for NO
 * @param {string} bondWei - bond amount in wei (as string)
 * @param {string} maxPreviousWei - max_previous in wei (as string)
 * @returns {ethers.TransactionResponse}
 */
export async function submitAnswer(signer, questionId, answerYes, bondWei, maxPreviousWei) {
  const realitio = getRealitioContract(signer);
  const answerBytes32 = answerYes ? ANSWER_YES : ANSWER_NO;
  const maxPrev = BigInt(maxPreviousWei || "0");

  const tx = await realitio.submitAnswer(
    questionId,
    answerBytes32,
    maxPrev,
    { value: BigInt(bondWei) }
  );

  return tx;
}

/**
 * Build a preview of the submitAnswer transaction (for user review - NFR-4).
 */
export function buildAnswerPreview(questionId, answerYes, bondWei, maxPreviousWei) {
  const answerBytes32 = answerYes ? ANSWER_YES : ANSWER_NO;
  return {
    contract: "Reality.eth v3.0",
    method: "submitAnswer(bytes32, bytes32, uint256)",
    params: {
      question_id: questionId,
      answer: answerBytes32,
      max_previous: maxPreviousWei,
    },
    value: `${ethers.formatEther(bondWei)} ETH`,
    valueWei: bondWei,
  };
}
