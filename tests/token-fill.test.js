import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fillTokens, extractTokens } from "../netlify/functions/v4/token-fill.js";

describe("extractTokens", () => {
  it("extracts token names from template", () => {
    const tokens = extractTokens("Hello [[NAME]], your balance is [[BALANCE]].");
    assert.deepEqual(tokens.sort(), ["BALANCE", "NAME"]);
  });

  it("returns empty array for no tokens", () => {
    const tokens = extractTokens("No tokens here.");
    assert.deepEqual(tokens, []);
  });

  it("deduplicates repeated tokens", () => {
    const tokens = extractTokens("[[A]] and [[A]] again");
    assert.deepEqual(tokens, ["A"]);
  });

  it("handles empty string", () => {
    const tokens = extractTokens("");
    assert.deepEqual(tokens, []);
  });
});

describe("fillTokens", () => {
  it("replaces text tokens", () => {
    const { html, unfilled_tokens } = fillTokens(
      "Hello [[NAME]]!",
      { NAME: "Nordfast" },
      [{ name: "NAME", type: "text", required: true }]
    );
    assert.ok(html.includes("Nordfast"));
    assert.equal(unfilled_tokens.length, 0);
  });

  it("tracks unfilled tokens", () => {
    const { html, unfilled_tokens } = fillTokens(
      "[[FILLED]] and [[MISSING]]",
      { FILLED: "yes" },
      [{ name: "FILLED", type: "text" }, { name: "MISSING", type: "text" }]
    );
    assert.ok(html.includes("yes"));
    assert.ok(unfilled_tokens.includes("MISSING"));
  });

  it("escapes HTML in text tokens", () => {
    const { html } = fillTokens(
      "[[NAME]]",
      { NAME: '<script>alert("xss")</script>' },
      [{ name: "NAME", type: "text" }]
    );
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("handles missing schema data gracefully", () => {
    const { html, unfilled_tokens } = fillTokens("[[A]]", {});
    assert.ok(unfilled_tokens.includes("A"));
  });

  it("handles null/undefined template", () => {
    const { html } = fillTokens(null, { A: "test" });
    assert.equal(html, "");
  });
});
