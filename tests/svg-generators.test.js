import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateBarChart,
  generateDonutChart,
  generateMapBubble,
  generateStockChart,
  generateNavVsPrice,
  generateChart,
} from "../netlify/functions/v4/svg-generators.js";

const COLORS = {
  primary: "#1A2B5C",
  secondary: "#4A7C9E",
  accent: "#E8A838",
  text: "#1A1A1A",
  text_light: "#666666",
  bg: "#FFFFFF",
  bg_alt: "#F5F5F0",
  surface: "#E8E4DE",
};

describe("generateBarChart", () => {
  it("generates valid SVG with data", () => {
    const svg = generateBarChart({
      title: "Intäkter",
      categories: ["Q1", "Q2", "Q3", "Q4"],
      series: [{ name: "2025", values: [100, 120, 110, 150], type: "bar" }],
    }, COLORS);
    assert.ok(svg.startsWith("<svg"));
    assert.ok(svg.includes("</svg>"));
    assert.ok(svg.includes("Intäkter"));
    assert.ok(svg.includes("<rect")); // bars
  });

  it("handles multi-series with bar + line", () => {
    const svg = generateBarChart({
      categories: ["Jan", "Feb", "Mar"],
      series: [
        { name: "Faktisk", values: [100, 110, 120], type: "bar" },
        { name: "Budget", values: [95, 105, 115], type: "line" },
      ],
    }, COLORS);
    assert.ok(svg.includes("<polyline")); // line
    assert.ok(svg.includes("Faktisk"));
    assert.ok(svg.includes("Budget"));
  });

  it("handles empty data", () => {
    const svg = generateBarChart({ categories: [], series: [] }, COLORS);
    assert.ok(svg.includes("Ingen data"));
  });

  it("handles negative values", () => {
    const svg = generateBarChart({
      categories: ["A"],
      series: [{ name: "Test", values: [-50], type: "bar" }],
    }, COLORS);
    assert.ok(svg.includes("<rect"));
  });
});

describe("generateDonutChart", () => {
  it("generates valid SVG with segments", () => {
    const svg = generateDonutChart({
      title: "Fördelning",
      segments: [
        { label: "Bostäder", value: 60 },
        { label: "Kontor", value: 30 },
        { label: "Lager", value: 10 },
      ],
    }, COLORS);
    assert.ok(svg.includes("<path"));
    assert.ok(svg.includes("Fördelning"));
    assert.ok(svg.includes("Bostäder"));
  });

  it("handles inner label", () => {
    const svg = generateDonutChart({
      segments: [{ label: "A", value: 100 }],
      inner_label: "100%",
    }, COLORS);
    assert.ok(svg.includes("100%"));
  });

  it("handles empty segments", () => {
    const svg = generateDonutChart({ segments: [] }, COLORS);
    assert.ok(svg.includes("Ingen data"));
  });
});

describe("generateMapBubble", () => {
  it("generates SVG with bubbles", () => {
    const svg = generateMapBubble({
      title: "Fastighetsbestånd",
      bubbles: [
        { name: "Stockholm", lat: 59.33, lon: 18.07, value: 500, color_role: "dominant" },
        { name: "Göteborg", lat: 57.71, lon: 11.97, value: 200, color_role: "second" },
      ],
    }, COLORS);
    assert.ok(svg.includes("Stockholm"));
    assert.ok(svg.includes("Göteborg"));
    assert.ok(svg.includes("<circle"));
  });

  it("handles empty bubbles", () => {
    const svg = generateMapBubble({ bubbles: [] }, COLORS);
    assert.ok(svg.includes("<svg"));
    assert.ok(!svg.includes("<circle")); // no bubbles, only map path
  });
});

describe("generateStockChart", () => {
  it("generates price + volume chart", () => {
    const svg = generateStockChart({
      title: "NIVI B",
      data: [
        { date: "2025-01", price: 45.5, volume: 10000 },
        { date: "2025-02", price: 47.2, volume: 12000 },
        { date: "2025-03", price: 46.8, volume: 8000 },
      ],
      show_volume: true,
    }, COLORS);
    assert.ok(svg.includes("NIVI B"));
    assert.ok(svg.includes("<polyline")); // price line
    assert.ok(svg.includes("<rect")); // volume bars
  });

  it("handles empty data", () => {
    const svg = generateStockChart({ data: [] }, COLORS);
    assert.ok(svg.includes("Ingen data"));
  });
});

describe("generateNavVsPrice", () => {
  it("generates dual-line chart", () => {
    const svg = generateNavVsPrice({
      title: "NAV vs Aktiekurs",
      data: [
        { date: "2025-01", nav_per_share: 55, price: 45 },
        { date: "2025-02", nav_per_share: 56, price: 47 },
        { date: "2025-03", nav_per_share: 57, price: 46 },
      ],
    }, COLORS);
    assert.ok(svg.includes("NAV vs Aktiekurs"));
    const polylines = svg.match(/<polyline/g);
    assert.ok(polylines && polylines.length >= 2); // NAV line + price line
  });

  it("handles empty data", () => {
    const svg = generateNavVsPrice({ data: [] }, COLORS);
    assert.ok(svg.includes("Ingen data"));
  });
});

describe("generateChart (dispatch)", () => {
  it("dispatches bar_chart", () => {
    const svg = generateChart("bar_chart", {
      categories: ["A"], series: [{ name: "X", values: [10] }],
    }, COLORS);
    assert.ok(svg.includes("<rect"));
  });

  it("dispatches donut_chart", () => {
    const svg = generateChart("donut_chart", {
      segments: [{ label: "A", value: 50 }],
    }, COLORS);
    assert.ok(svg.includes("<path"));
  });

  it("returns placeholder for unknown type", () => {
    const svg = generateChart("unknown_chart", {}, COLORS);
    assert.ok(svg.includes("Okänd diagramtyp"));
  });
});
