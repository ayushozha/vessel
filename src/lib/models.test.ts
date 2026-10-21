import { describe, expect, it } from "vitest";

import { sanitizeChatgptBody } from "./models";

describe("sanitizeChatgptBody", () => {
  it("removes parameters the ChatGPT plan route rejects and forces store:false, stream:true", () => {
    const out = sanitizeChatgptBody({
      model: "m",
      input: [],
      temperature: 0.2,
      max_output_tokens: 100,
      previous_response_id: "r",
      top_p: 1,
      user: "u",
      metadata: {},
      store: true,
      stream: false,
      tools: [{ type: "function" }],
    });
    expect(out).toEqual({ model: "m", input: [], store: false, stream: true, tools: [{ type: "function" }] });
  });

  it("moves system items into instructions, since system-role items are rejected", () => {
    const out = sanitizeChatgptBody({
      instructions: "base",
      input: [
        { role: "system", content: "You are Adorable." },
        { role: "system", content: [{ type: "input_text", text: "Write files." }] },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    expect(out.instructions).toBe("base\n\nYou are Adorable.\n\nWrite files.");
    expect(out.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  });

  it("leaves developer messages alone", () => {
    const input = [{ role: "developer", content: "rules" }];
    expect(sanitizeChatgptBody({ input }).input).toEqual(input);
  });
});
