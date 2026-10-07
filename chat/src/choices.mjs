import { problem } from "./personal-http.mjs";

export const CHOICE_TOOL = {
    name: "request_user_choice",
    description:
        "Ask the user a modelling decision using clickable options. Use multiple=true only when several choices can apply. Wait for their answer before continuing. Do not ask for credentials or use this as write confirmation or clinical approval.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
            question: { type: "string", minLength: 1, maxLength: 500 },
            options: {
                type: "array",
                minItems: 2,
                maxItems: 8,
                uniqueItems: true,
                items: { type: "string", minLength: 1, maxLength: 160 },
            },
            multiple: { type: "boolean" },
        },
        required: ["question", "options"],
    },
};

export function choiceQuestion(input) {
    if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !["question", "options", "multiple"].includes(key)) ||
        typeof input.question !== "string" ||
        !input.question.trim() ||
        input.question.length > 500 ||
        !Array.isArray(input.options) ||
        input.options.length < 2 ||
        input.options.length > 8 ||
        input.options.some((option) => typeof option !== "string" || !option.trim() || option.length > 160) ||
        new Set(input.options.map((option) => option.trim())).size !== input.options.length ||
        (input.multiple !== undefined && typeof input.multiple !== "boolean")
    )
        throw problem("Provide a short question and two to eight distinct options.");
    return {
        question: input.question.trim(),
        options: input.options.map((option) => option.trim()),
        multiple: input.multiple || false,
    };
}

export function choiceAnswer(question, input) {
    if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !["id", "selected", "text", "cancelled"].includes(key)) ||
        (input.cancelled !== undefined && typeof input.cancelled !== "boolean")
    )
        throw problem("Choose an option or enter your answer.");
    if (input.cancelled) return { ...question, selected: [], text: "", cancelled: true };
    const selected = input.selected ?? [],
        text = input.text ?? "";
    if (
        !Array.isArray(selected) ||
        selected.length > (question.multiple ? question.options.length : 1) ||
        selected.some((option) => !question.options.includes(option)) ||
        new Set(selected).size !== selected.length ||
        typeof text !== "string" ||
        text.length > 2000 ||
        (!selected.length && !text.trim())
    )
        throw problem(
            question.multiple
                ? "Choose one or more options or enter your answer."
                : "Choose one option or enter your answer.",
        );
    return { ...question, selected, text: text.trim(), cancelled: false };
}

export function choiceMessage(answer) {
    return (
        "My choice for “" +
        answer.question +
        "”: " +
        [...answer.selected, ...(answer.text ? [answer.text] : [])].join("; ")
    );
}
