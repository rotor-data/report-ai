import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateContentSchema,
  validateSchemaData,
  ManifestInputSchema,
} from "../netlify/functions/v4/content-schema-validator.js";

describe("validateContentSchema", () => {
  it("accepts a valid content-schema", () => {
    const result = validateContentSchema({
      page_types: ["cover", "summary", "financial_table"],
      page_type_map: [
        { page_type: "cover", layout_name: "page-cover", token_list: ["COMPANY_NAME"] },
      ],
      global_fields: {
        company_name: { type: "text", required: true },
      },
      scalability: {
        repeatable_page_types: ["financial_table"],
      },
    });
    assert.equal(result.valid, true);
    assert.equal(result.issues.length, 0);
  });

  it("accepts minimal schema", () => {
    const result = validateContentSchema({});
    assert.equal(result.valid, true);
  });

  it("rejects invalid schema types", () => {
    const result = validateContentSchema("not an object");
    assert.equal(result.valid, false);
    assert.ok(result.issues.length > 0);
  });
});

describe("validateSchemaData", () => {
  it("passes when required global fields are present", () => {
    const schema = {
      global_fields: {
        company_name: { type: "text", required: true },
      },
      page_types: [],
    };
    const data = {
      global: { company_name: "Nordfast AB" },
      pages: [],
    };
    const result = validateSchemaData(schema, data);
    assert.equal(result.valid, true);
  });

  it("fails when required global fields are missing", () => {
    const schema = {
      global_fields: {
        company_name: { type: "text", required: true },
      },
      page_types: [],
    };
    const data = { global: {}, pages: [] };
    const result = validateSchemaData(schema, data);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.includes("company_name")));
  });
});

describe("ManifestInputSchema", () => {
  it("accepts source_url only", () => {
    const result = ManifestInputSchema.safeParse({
      source_url: "https://example.com/report.pdf",
    });
    assert.equal(result.success, true);
  });

  it("accepts file_base64 only", () => {
    const result = ManifestInputSchema.safeParse({
      file_base64: "JVBERi0xLjQK",
    });
    assert.equal(result.success, true);
  });

  it("rejects both source_url and file_base64", () => {
    const result = ManifestInputSchema.safeParse({
      source_url: "https://example.com/report.pdf",
      file_base64: "JVBERi0xLjQK",
    });
    assert.equal(result.success, false);
  });

  it("rejects neither source_url nor file_base64", () => {
    const result = ManifestInputSchema.safeParse({});
    assert.equal(result.success, false);
  });
});
