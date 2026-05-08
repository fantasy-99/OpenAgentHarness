import { z } from "zod";

import type { EngineToolSet } from "../types.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const ASK_USER_QUESTION_DESCRIPTION = `Ask the user 1-4 structured questions when progress depends on their preference or missing context.

Use this instead of guessing when the answer materially changes implementation, UX, scope, or safety. The tool returns a structured awaiting_user payload so the assistant can present the questions and continue after the user answers.`;

const QuestionOptionSchema = z
  .object({
    label: z.string().min(1).describe("Short display text for the option, ideally 1-5 words."),
    description: z.string().min(1).describe("What choosing this option means or what will happen."),
    preview: z.string().optional().describe("Optional preview content for UI renderers that support focused option previews.")
  })
  .strict();

const QuestionSchema = z
  .object({
    question: z.string().min(1).describe("The complete, clear question to ask the user."),
    header: z.string().min(1).optional().describe("Very short label for the question, such as Auth method or Approach."),
    options: z.array(QuestionOptionSchema).min(2).max(4).optional().describe("Optional choices for the question."),
    multiSelect: z.boolean().default(false).describe("Allow selecting multiple options when choices are not mutually exclusive."),
    freeText: z.boolean().default(true).describe("Allow the user to provide a free-text answer or clarification.")
  })
  .strict();

const AskUserQuestionInputSchema = z
  .object({
    questions: z.array(QuestionSchema).min(1).max(4).describe("Questions to ask the user."),
    context: z.string().optional().describe("Brief context explaining why these answers are needed."),
    metadata: z.record(z.string(), z.unknown()).optional().describe("Optional non-rendered metadata for callers.")
  })
  .strict()
  .refine(
    (data) => {
      const questionTexts = data.questions.map((question) => question.question);
      if (questionTexts.length !== new Set(questionTexts).size) {
        return false;
      }

      for (const question of data.questions) {
        if (!question.options) {
          continue;
        }
        const optionLabels = question.options.map((option) => option.label);
        if (optionLabels.length !== new Set(optionLabels).size) {
          return false;
        }
      }

      return true;
    },
    {
      message: "Question texts must be unique, and option labels must be unique within each question."
    }
  );

export function createAskUserQuestionTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    AskUserQuestion: {
      description: ASK_USER_QUESTION_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("AskUserQuestion"),
      inputSchema: AskUserQuestionInputSchema,
      async execute(rawInput) {
        context.assertVisible("AskUserQuestion");
        const input = AskUserQuestionInputSchema.parse(rawInput);

        return {
          type: "json",
          value: {
            status: "awaiting_user",
            message: "Present these questions to the user and wait for their answer before continuing.",
            questions: input.questions,
            ...(input.context ? { context: input.context } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {})
          }
        };
      }
    }
  };
}
