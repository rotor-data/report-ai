import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync(
  new URL("../db/migrations/008_report_v2.sql", import.meta.url),
  "utf8",
);

const normalized = sql.toLowerCase().replace(/\s+/g, " ");

function expectContains(regex, message) {
  assert.match(normalized, regex, message);
}

describe("008_report_v2.sql", () => {
  it("creates all expected v2 tables", () => {
    const tables = [
      "brands",
      "brand_fonts",
      "brand_logos",
      "tenant_assets",
      "report_templates",
      "v2_reports",
      "v2_report_pages",
      "v2_report_modules",
      "report_blueprints",
    ];

    for (const table of tables) {
      expectContains(
        new RegExp(`create table if not exists ${table}\\s*\\(`),
        `missing table: ${table}`,
      );
    }
  });

  it("enforces constrained values for asset_class and module_type", () => {
    expectContains(
      /asset_class text not null check \(asset_class in \('photo', 'icon', 'svg'\)\)/,
      "tenant_assets.asset_class check is missing or changed",
    );
    expectContains(
      /module_type text not null check \(module_type in \('cover', 'chapter_break', 'back_cover', 'layout'\)\)/,
      "v2_report_modules.module_type check is missing or changed",
    );
  });

  it("adds indexes needed for query paths", () => {
    const indexes = [
      "idx_brands_tenant_id",
      "idx_brand_fonts_brand_id",
      "idx_brand_logos_brand_id",
      "idx_tenant_assets_tenant_id",
      "idx_v2_reports_tenant_id",
      "idx_v2_reports_brand_id",
      "idx_v2_report_pages_report_id",
      "idx_v2_report_modules_report_order",
      "idx_v2_report_modules_page_id",
      "idx_report_blueprints_brand_id",
    ];

    for (const indexName of indexes) {
      expectContains(
        new RegExp(`create index if not exists ${indexName}\\s+on\\s+`),
        `missing index: ${indexName}`,
      );
    }
  });

  it("keeps expected fk references for report graph", () => {
    expectContains(
      /brand_id uuid references brands\(id\) on delete set null/,
      "v2_reports.brand_id fk missing",
    );
    expectContains(
      /report_id uuid not null references v2_reports\(id\) on delete cascade/,
      "v2_report_pages.report_id fk missing",
    );
    expectContains(
      /page_id uuid references v2_report_pages\(id\) on delete set null/,
      "v2_report_modules.page_id fk missing",
    );
    expectContains(
      /brand_id uuid not null references brands\(id\) on delete cascade/,
      "report_blueprints.brand_id fk missing",
    );
  });
});

