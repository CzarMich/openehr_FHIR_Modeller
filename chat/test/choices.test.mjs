import test from "node:test";
import assert from "node:assert/strict";
import { choiceQuestion, choiceAnswer } from "../src/choices.mjs";

test("choice questions and answers are bounded and distinguish single, multiple, custom and skipped answers", () => {
    const question = choiceQuestion({
        question: " Intended use? ",
        options: ["Documentation", "Detection"],
        multiple: true,
    });
    assert.equal(question.question, "Intended use?");
    assert.deepEqual(choiceAnswer(question, { selected: question.options }).selected, question.options);
    assert.equal(choiceAnswer(question, { text: " Research " }).text, "Research");
    assert.deepEqual(choiceAnswer(question, { cancelled: true }).selected, []);
    for (const input of [
        null,
        {},
        { ...question, options: ["one"] },
        { ...question, options: ["one", " one "] },
        { ...question, question: "a".repeat(501) },
        { ...question, multiple: "yes" },
    ])
        assert.throws(() => choiceQuestion(input));
    for (const input of [
        {},
        { selected: ["other"] },
        { selected: ["Detection", "Detection"] },
        { text: "a".repeat(2001) },
        { selected: question.options, approved: true },
    ])
        assert.throws(() => choiceAnswer(question, input));
    assert.throws(() => choiceAnswer({ ...question, multiple: false }, { selected: question.options }));
});
