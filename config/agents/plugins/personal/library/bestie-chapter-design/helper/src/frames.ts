import {
  type Bounds,
  bounds,
  flag,
  integer,
  type JsonRecord,
  list,
  numeric,
  optional,
  readJson,
  record,
  text,
} from "./input.ts";

/** One labelled page item from the native format readback. */
export type Frame = {
  page: number;
  label: string;
  kind: string | undefined;
  bounds: Bounds;
  /** Measured text extent; geometry trusts it only with a glyph-tight inkMethod. */
  ink: Bounds | undefined;
  /** How ink was measured, for example raster-glyph or pdf-word-box. */
  inkMethod: string | undefined;
  visible: boolean | undefined;
  fill: string | undefined;
  z: number | undefined;
  ranges: JsonRecord[];
};

function frame(value: unknown, where: string): Frame {
  const item = record(value, where);
  const ranges =
    optional(item.ranges, (v) => list(v, `${where}.ranges`)) ?? [];
  return {
    bounds: bounds(item.bounds, `${where}.bounds`),
    ink: optional(item.ink, (v) => bounds(v, `${where}.ink`)),
    inkMethod: optional(item.inkMethod, (v) => text(v, `${where}.inkMethod`)),
    fill: optional(item.fill, (v) => text(v, `${where}.fill`)),
    kind: optional(item.kind, (v) => text(v, `${where}.kind`)),
    label: text(item.label, `${where}.label`),
    page: integer(item.page, `${where}.page`),
    ranges: ranges.map((range, index) =>
      record(range, `${where}.ranges[${index}]`),
    ),
    visible: optional(item.visible, (v) => flag(v, `${where}.visible`)),
    z: optional(item.z, (v) => numeric(v, `${where}.z`)),
  };
}

/** Reads the existing format readback: an array of labelled frames. */
export function readFrames(path: string): Frame[] {
  return list(readJson(path), path).map((entry, index) =>
    frame(entry, `${path}[${index}]`),
  );
}

export function frameText(item: Frame): string {
  return item.ranges.map((range) => String(range.text ?? "")).join("");
}

export function frameStyles(item: Frame): string[] {
  return item.ranges.map((range) => String(range.style ?? ""));
}
