import { createHash } from "node:crypto";
import type {
  AmbiguityRecord,
  ArchiveState,
  AssociationRecord,
  AttachmentFile,
  BlobRecord,
  DecisionRecord,
  ExportRow,
  ImageType,
  ImportPlan,
  ItemRecord,
  MediaKind,
  ObservationRecord,
  ObservationStrategy,
  ParsedExport,
} from "./model.ts";

const SEPARATOR = "\u001f";
const TRUNCATED_STEM_LENGTH = 40;
const IMAGE_EXTENSIONS = new Set([
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);
const URL_IN_TEXT = /https?:\/\//i;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * LF line endings, NFC, leading and trailing whitespace trimmed from the text,
 * and trailing whitespace trimmed from each line.
 */
function normaliseText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function fingerprint(row: ExportRow): string {
  return sha256(
    [
      "v1",
      row.messageDate,
      row.direction,
      normaliseText(row.text),
      row.attachment.normalize("NFC"),
    ].join(SEPARATOR),
  );
}

function itemKeyFor(...basis: string[]): string {
  return `itm_${sha256(basis.join(SEPARATOR)).slice(0, 24)}`;
}

/** Exported attachment names begin with the Message Date, colons as spaces. */
function exportTimestamp(messageDate: string): string {
  return messageDate.replaceAll(":", " ");
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

export function emptyState(): ArchiveState {
  return {
    ambiguities: new Map(),
    associations: new Map(),
    blobs: new Map(),
    decisions: new Map(),
    fingerprintIndex: new Map(),
    idIndex: new Map(),
    items: new Map(),
    linkedItems: new Set(),
    observedRows: new Map(),
    originals: new Set(),
    revision: "empty",
  };
}

export interface ArchiveRecords {
  ambiguities: AmbiguityRecord[];
  associations: AssociationRecord[];
  blobs: BlobRecord[];
  decisions: DecisionRecord[];
  items: ItemRecord[];
  observations: ObservationRecord[];
}

function addItem(state: ArchiveState, item: ItemRecord): void {
  state.items.set(item.itemKey, item);
  const keys = state.fingerprintIndex.get(item.fingerprint) ?? [];
  state.fingerprintIndex.set(item.fingerprint, [...keys, item.itemKey]);
}

function addObservation(state: ArchiveState, record: ObservationRecord): void {
  state.observedRows.set(
    `${record.exportSha256}:${record.row}`,
    record.itemKey,
  );
  state.originals.add(record.exportSha256);
  if (record.itemKey === null) return;
  if (record.messageId !== null && record.part !== null) {
    state.idIndex.set(
      `${record.messageId}${SEPARATOR}${record.part}`,
      record.itemKey,
    );
  }
  if (record.strategy === "message-id-linked-fingerprint") {
    state.linkedItems.add(record.itemKey);
  }
}

function addAssociation(
  state: ArchiveState,
  record: AssociationRecord,
): void {
  const existing = state.associations.get(record.associationKey);
  if (existing?.status !== "resolved") {
    state.associations.set(record.associationKey, record);
  }
}

function addAmbiguity(state: ArchiveState, record: AmbiguityRecord): void {
  for (const itemKey of record.itemKeys) {
    const others = state.ambiguities.get(itemKey) ?? new Set<string>();
    for (const other of record.itemKeys) if (other !== itemKey) others.add(other);
    state.ambiguities.set(itemKey, others);
  }
}

function addDecision(state: ArchiveState, record: DecisionRecord): void {
  const previous = state.decisions.get(record.itemKey);
  state.decisions.set(record.itemKey, { ...previous, ...record });
}

/** Folds durable records into the in-memory indexes; later records win. */
export function foldRecords(
  state: ArchiveState,
  records: ArchiveRecords,
): ArchiveState {
  for (const item of records.items) addItem(state, item);
  for (const observation of records.observations) {
    addObservation(state, observation);
  }
  for (const association of records.associations) {
    addAssociation(state, association);
  }
  for (const blob of records.blobs) state.blobs.set(blob.sha256, blob);
  for (const ambiguity of records.ambiguities) addAmbiguity(state, ambiguity);
  for (const decision of records.decisions) addDecision(state, decision);
  return state;
}

interface ItemPlanning {
  ambiguities: AmbiguityRecord[];
  ambiguousMessages: { candidates: string[]; row: number }[];
  ambiguousLinks: { candidates: string[]; itemKey: string; row: number }[];
  counts: Record<ObservationStrategy | "alreadyObserved", number>;
  items: ItemRecord[];
  nearMatches: { itemKeys: string[]; row: number }[];
  observations: ObservationRecord[];
  rowItems: Map<number, string>;
}

function newItem(
  row: ExportRow,
  parsed: ParsedExport,
  exportSha256: string,
  itemKey: string,
  part: string | null,
): ItemRecord {
  return {
    attachment:
      row.attachment === ""
        ? null
        : { originalName: row.attachment, type: row.attachmentType },
    chatSession: parsed.chatSession,
    deletedDate: row.deletedDate,
    deliveredDate: row.deliveredDate,
    direction: row.direction,
    editedDate: row.editedDate,
    fingerprint: fingerprint(row),
    firstSeen: { exportSha256, row: row.row },
    itemKey,
    messageDate: row.messageDate,
    messageId: row.messageId,
    part,
    reactions: row.reactions,
    readDate: row.readDate,
    recordVersion: 1,
    replyingTo: row.replyingTo,
    senderId: row.senderId,
    senderName: row.senderName,
    service: row.service,
    status: row.status,
    text: row.text,
  };
}

/**
 * Part keys independent of row order: `text` or `att:<name>`, numbered
 * within the message after sorting by content hash, then fingerprint.
 */
function partKeys(
  rows: ExportRow[],
  rowSha: Map<number, string>,
): Map<number, string> {
  const groups = new Map<string, ExportRow[]>();
  const kindOf = (row: ExportRow) =>
    row.attachment === "" ? "text" : `att:${row.attachment.normalize("NFC")}`;
  for (const row of rows) {
    const key = `${row.messageId}${SEPARATOR}${kindOf(row)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const parts = new Map<number, string>();
  const order = (row: ExportRow) =>
    `${rowSha.get(row.row) ?? "~"}${SEPARATOR}${fingerprint(row)}`;
  for (const group of groups.values()) {
    group.sort((left, right) => order(left).localeCompare(order(right)));
    group.forEach((row, index) => {
      parts.set(row.row, `${kindOf(row)}#${index}`);
    });
  }
  return parts;
}

function countBy<T>(values: T[], key: (value: T) => string) {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  }
  return counts;
}

/** `<message id><sep><sha>` to items holding those bytes as a cell. */
function contentIndex(state: ArchiveState): Map<string, string[]> {
  const messageIds = new Map<string, string>();
  for (const [key, itemKey] of state.idIndex) {
    messageIds.set(itemKey, key.slice(0, key.indexOf(SEPARATOR)));
  }
  const index = new Map<string, string[]>();
  for (const record of state.associations.values()) {
    const messageId = messageIds.get(record.itemKey);
    if (record.source !== "attachment-cell" || record.sha256 === null) continue;
    if (messageId === undefined) continue;
    const key = `${messageId}${SEPARATOR}${record.sha256}`;
    index.set(key, [...(index.get(key) ?? []), record.itemKey]);
  }
  return index;
}

class ItemPlanner {
  readonly result: ItemPlanning = {
    ambiguities: [],
    ambiguousLinks: [],
    ambiguousMessages: [],
    counts: {
      alreadyObserved: 0,
      "ambiguous-fingerprint": 0,
      "fingerprint-match": 0,
      "fingerprint-new": 0,
      "message-id-linked-fingerprint": 0,
      "message-id-match": 0,
      "message-id-new": 0,
    },
    items: [],
    nearMatches: [],
    observations: [],
    rowItems: new Map(),
  };
  private readonly dateDirection: Map<string, string[]>;

  constructor(
    private readonly state: ArchiveState,
    private readonly parsed: ParsedExport,
    private readonly exportSha256: string,
  ) {
    this.dateDirection = new Map();
    for (const item of state.items.values()) {
      const key = `${item.messageDate}|${item.direction}`;
      this.dateDirection.set(key, [
        ...(this.dateDirection.get(key) ?? []),
        item.itemKey,
      ]);
    }
  }

  observe(
    row: ExportRow,
    strategy: ObservationStrategy,
    itemKey: string | null,
    part: string | null,
    ambiguousCandidates: string[] = [],
  ): void {
    this.result.counts[strategy] += 1;
    this.result.observations.push({
      ambiguousCandidates,
      exportSha256: this.exportSha256,
      itemKey,
      messageId: row.messageId,
      part,
      recordVersion: 1,
      row: row.row,
      strategy,
    });
    if (itemKey !== null) this.result.rowItems.set(row.row, itemKey);
  }

  create(row: ExportRow, itemKey: string, part: string | null): void {
    const prior = this.dateDirection.get(
      `${row.messageDate}|${row.direction}`,
    );
    if (prior !== undefined) {
      this.result.nearMatches.push({ itemKeys: prior, row: row.row });
    }
    this.result.items.push(
      newItem(row, this.parsed, this.exportSha256, itemKey, part),
    );
  }

  /** Records both sides of an unresolved link so neither is a silent duplicate. */
  ambiguous(row: ExportRow, itemKey: string, candidates: string[]): void {
    this.result.ambiguousLinks.push({ candidates, itemKey, row: row.row });
    this.result.ambiguities.push({
      exportSha256: this.exportSha256,
      itemKeys: [itemKey, ...candidates].sort(),
      reason: "message-id-fingerprint",
      recordVersion: 1,
      row: row.row,
    });
  }

  candidates(row: ExportRow): string[] {
    return this.state.fingerprintIndex.get(fingerprint(row)) ?? [];
  }
}

function knownIdItem(
  state: ArchiveState,
  content: Map<string, string[]>,
  row: ExportRow,
  part: string,
  sha: string | undefined,
): string | undefined {
  const byPart = state.idIndex.get(`${row.messageId}${SEPARATOR}${part}`);
  if (byPart !== undefined || sha === undefined) return byPart;
  const byContent = content.get(`${row.messageId}${SEPARATOR}${sha}`) ?? [];
  return byContent.length === 1 ? byContent[0] : undefined;
}

function planIdRows(
  planner: ItemPlanner,
  state: ArchiveState,
  rows: ExportRow[],
  rowSha: Map<number, string>,
): void {
  const parts = partKeys(rows, rowSha);
  const content = contentIndex(state);
  const used = new Set<string>();
  const pending = rows.filter((row) => {
    const part = parts.get(row.row) ?? "";
    const known = knownIdItem(state, content, row, part, rowSha.get(row.row));
    if (known === undefined || used.has(known)) return true;
    used.add(known);
    planner.observe(row, "message-id-match", known, part);
    return false;
  });
  const fingerprintCounts = countBy(pending, fingerprint);
  for (const row of pending) {
    const part = parts.get(row.row) ?? "";
    const eligible = planner
      .candidates(row)
      .filter(
        (key) =>
          state.items.get(key)?.messageId === null &&
          !state.linkedItems.has(key),
      );
    const linkable =
      eligible.length === 1 && fingerprintCounts.get(fingerprint(row)) === 1;
    const [linked] = eligible;
    if (linkable && linked !== undefined) {
      planner.observe(row, "message-id-linked-fingerprint", linked, part);
      continue;
    }
    const itemKey = itemKeyFor("id", row.messageId ?? "", part);
    planner.create(row, itemKey, part);
    planner.observe(row, "message-id-new", itemKey, part, eligible);
    if (eligible.length > 0) planner.ambiguous(row, itemKey, eligible);
  }
}

/** A fingerprint repeated within the export is held: no identity is minted. */
function planFingerprintRows(planner: ItemPlanner, rows: ExportRow[]): void {
  const fingerprintCounts = countBy(rows, fingerprint);
  for (const row of rows) {
    const print = fingerprint(row);
    const candidates = planner.candidates(row);
    const [match] = candidates;
    const unique = fingerprintCounts.get(print) === 1;
    if (unique && match === undefined) {
      const itemKey = itemKeyFor("fp", print, "0");
      planner.create(row, itemKey, null);
      planner.observe(row, "fingerprint-new", itemKey, null);
    } else if (unique && match !== undefined && candidates.length === 1) {
      planner.observe(row, "fingerprint-match", match, null);
    } else {
      planner.observe(row, "ambiguous-fingerprint", null, null, candidates);
      planner.result.ambiguousMessages.push({ candidates, row: row.row });
    }
  }
}

function planItems(
  state: ArchiveState,
  parsed: ParsedExport,
  exportSha256: string,
  rowSha: Map<number, string>,
): ItemPlanning {
  const planner = new ItemPlanner(state, parsed, exportSha256);
  const fresh: ExportRow[] = [];
  for (const row of parsed.rows) {
    const seen = state.observedRows.get(`${exportSha256}:${row.row}`);
    if (seen === undefined) fresh.push(row);
    // Seen rows keep their item so unresolved attachments can resolve later.
    else if (seen !== null) planner.result.rowItems.set(row.row, seen);
  }
  planner.result.counts.alreadyObserved = parsed.rows.length - fresh.length;
  if (parsed.variant === "imazing-18") planIdRows(planner, state, fresh, rowSha);
  else planFingerprintRows(planner, fresh);
  return planner.result;
}

export interface CellResolution {
  candidates: string[];
  file: AttachmentFile | null;
  hints: string[];
  status: "ambiguous" | "missing" | "resolved";
  strategy: "exact" | "none" | "variant-name";
}

function stemOf(name: string): string {
  return name.slice(0, name.length - extensionOf(name).length);
}

/** Truncated (40-character stem) or ` N`-suffixed exported name. */
function isNameVariant(cell: string, exported: string): boolean {
  const extension = extensionOf(cell);
  if (extensionOf(exported).toLowerCase() !== extension.toLowerCase()) {
    return false;
  }
  const exportedStem = stemOf(exported).replace(/ \d+$/, "");
  const stem = stemOf(cell);
  return (
    exportedStem === stem ||
    (stem.length > TRUNCATED_STEM_LENGTH &&
      exportedStem === stem.slice(0, TRUNCATED_STEM_LENGTH))
  );
}

function resolveGroup(cell: string, sameTime: AttachmentFile[]): CellResolution {
  const exact = sameTime.filter((file) => file.exportedName === cell);
  const variants = sameTime.filter(
    (file) => file.exportedName !== cell && isNameVariant(cell, file.exportedName),
  );
  const all = [...exact, ...variants];
  const candidates = all.map((file) => file.relativePath).sort();
  const file = all[0] ?? null;
  if (file === null) {
    const hints = sameTime.map((other) => other.relativePath).sort();
    return { candidates, file, hints, status: "missing", strategy: "none" };
  }
  if (new Set(all.map((candidate) => candidate.sha256)).size > 1) {
    return { candidates, file: null, hints: [], status: "ambiguous", strategy: "none" };
  }
  const strategy = exact.length > 0 ? "exact" : "variant-name";
  return { candidates, file, hints: [], status: "resolved", strategy };
}

function byTimestamp(files: AttachmentFile[]): Map<string, AttachmentFile[]> {
  const index = new Map<string, AttachmentFile[]>();
  for (const file of files) {
    index.set(file.timestamp, [...(index.get(file.timestamp) ?? []), file]);
  }
  return index;
}

export interface WebLinkResolution {
  ambiguous: { file: string; rows: number[] }[];
  resolved: { file: AttachmentFile; row: number }[];
}

export interface AttachmentResolution {
  cells: Map<number, CellResolution>;
  unreferenced: string[];
  webLinks: WebLinkResolution;
}

function resolveWebLinks(
  rows: ExportRow[],
  files: AttachmentFile[],
  claimed: Set<string>,
): WebLinkResolution {
  const result: WebLinkResolution = { ambiguous: [], resolved: [] };
  for (const file of files) {
    if (claimed.has(file.relativePath)) continue;
    if (extensionOf(file.exportedName).toLowerCase() !== ".url") continue;
    const linked = rows.filter(
      (row) =>
        exportTimestamp(row.messageDate) === file.timestamp &&
        URL_IN_TEXT.test(row.text),
    );
    const [only] = linked;
    if (linked.length === 0) continue;
    claimed.add(file.relativePath);
    if (only !== undefined && linked.length === 1) {
      result.resolved.push({ file, row: only.row });
    } else {
      const rowNumbers = linked.map((row) => row.row);
      result.ambiguous.push({ file: file.relativePath, rows: rowNumbers });
    }
  }
  return result;
}

export function resolveAttachments(
  rows: ExportRow[],
  files: AttachmentFile[],
): AttachmentResolution {
  const index = byTimestamp(files);
  const cells = new Map<number, CellResolution>();
  const groups = new Map<string, CellResolution>();
  const claimed = new Set<string>();
  for (const row of rows) {
    if (row.attachment === "") continue;
    const timestamp = exportTimestamp(row.messageDate);
    const groupKey = `${timestamp}${SEPARATOR}${row.attachment}`;
    const resolution =
      groups.get(groupKey) ??
      resolveGroup(row.attachment, index.get(timestamp) ?? []);
    groups.set(groupKey, resolution);
    for (const candidate of resolution.candidates) claimed.add(candidate);
    cells.set(row.row, resolution);
  }
  const webLinks = resolveWebLinks(rows, files, claimed);
  const unreferenced = files
    .map((file) => file.relativePath)
    .filter((path) => !claimed.has(path))
    .sort();
  return { cells, unreferenced, webLinks };
}

function mediaKind(attachmentType: string, name: string): MediaKind {
  if (attachmentType === "Image") return "image";
  if (attachmentType === "Video") return "video";
  if (attachmentType === "Audio") return "audio";
  return IMAGE_EXTENSIONS.has(extensionOf(name).toLowerCase())
    ? "image"
    : "attachment";
}

function detectedImageType(kind: MediaKind, name: string): ImageType {
  if (kind === "web-link") return "url";
  if (kind !== "image") return "other";
  return extensionOf(name).toLowerCase() === ".gif" ? "gif" : "unknown";
}

function blobPath(sha: string, name: string): string {
  return `blobs/${sha.slice(0, 2)}/${sha}${extensionOf(name).toLowerCase()}`;
}

interface AssociationInput {
  file: AttachmentFile | null;
  itemKey: string;
  kind: MediaKind;
  originalName: string | null;
  resolution: {
    candidates: string[];
    status: AssociationRecord["status"];
    strategy: AssociationRecord["strategy"];
  };
  row: number;
}

function association(
  input: AssociationInput,
  exportSha256: string,
): AssociationRecord {
  const source = input.kind === "web-link" ? "web-link" : "attachment-cell";
  const name = input.file?.exportedName ?? input.originalName ?? "";
  return {
    associationKey:
      source === "web-link"
        ? `${input.itemKey}|web-link|${input.file?.sha256}`
        : `${input.itemKey}|cell`,
    candidates: input.resolution.candidates,
    detectedImageType: detectedImageType(input.kind, name),
    exportSha256,
    exportedPath: input.file?.relativePath ?? null,
    itemKey: input.itemKey,
    mediaKind: input.kind,
    originalName: input.originalName,
    recordVersion: 1,
    row: input.row,
    sha256: input.file?.sha256 ?? null,
    source,
    status: input.resolution.status,
    strategy: input.resolution.strategy,
  };
}

function associationInputs(
  rows: ExportRow[],
  rowItems: Map<number, string>,
  resolution: AttachmentResolution,
): AssociationInput[] {
  const inputs: AssociationInput[] = [];
  for (const row of rows) {
    const itemKey = rowItems.get(row.row);
    const cell = resolution.cells.get(row.row);
    if (itemKey === undefined || cell === undefined) continue;
    const kind = mediaKind(row.attachmentType, row.attachment);
    const file = cell.status === "resolved" ? cell.file : null;
    const originalName = row.attachment;
    inputs.push({ file, itemKey, kind, originalName, resolution: cell, row: row.row });
  }
  for (const link of resolution.webLinks.resolved) {
    const itemKey = rowItems.get(link.row);
    if (itemKey === undefined) continue;
    inputs.push({
      file: link.file,
      itemKey,
      kind: "web-link",
      originalName: null,
      resolution: {
        candidates: [link.file.relativePath],
        status: "resolved",
        strategy: "web-link-timestamp",
      },
      row: link.row,
    });
  }
  return inputs;
}

function planAssociations(
  state: ArchiveState,
  inputs: AssociationInput[],
  exportSha256: string,
): { associations: AssociationRecord[]; blobs: BlobRecord[] } {
  const associations = new Map<string, AssociationRecord>();
  const blobs = new Map<string, BlobRecord>();
  for (const input of inputs) {
    const record = association(input, exportSha256);
    const existing =
      associations.get(record.associationKey) ??
      state.associations.get(record.associationKey);
    if (existing?.status === "resolved") continue;
    if (existing !== undefined && record.status !== "resolved") continue;
    associations.set(record.associationKey, record);
    const file = input.file;
    if (file === null || state.blobs.has(file.sha256)) continue;
    blobs.set(file.sha256, {
      path: blobPath(file.sha256, file.exportedName),
      recordVersion: 1,
      sha256: file.sha256,
      size: file.size,
      sourcePath: file.relativePath,
    });
  }
  return { associations: [...associations.values()], blobs: [...blobs.values()] };
}

function countStatuses(values: Iterable<{ status: string }>) {
  const counts = { ambiguous: 0, missing: 0, resolved: 0 };
  for (const value of values) {
    counts[value.status as keyof typeof counts] += 1;
  }
  return counts;
}

export interface PlannedImport {
  digest: string;
  plan: ImportPlan;
  summary: ImportSummary;
}

export interface ImportSummary {
  attachmentRows: number;
  attachmentRowResolution: { ambiguous: number; missing: number; resolved: number };
  chatFiles: number;
  lists: {
    ambiguousAttachments: { candidates: string[]; row: number }[];
    ambiguousMessageLinks: { candidates: string[]; itemKey: string; row: number }[];
    ambiguousMessages: { candidates: string[]; row: number }[];
    ambiguousWebLinks: { file: string; rows: number[] }[];
    missingAttachments: { cell: string; row: number; sameTimestampFiles: string[] }[];
    nearMatches: { itemKeys: string[]; row: number }[];
    unreferencedFiles: string[];
  };
  messageRows: number;
  observations: Record<string, number>;
  planned: {
    associations: { ambiguous: number; missing: number; resolved: number };
    blobs: number;
    blobBytes: number;
    ambiguities: number;
    copyOriginal: boolean;
    items: number;
    observations: number;
  };
  variant: ParsedExport["variant"];
  webLinks: { ambiguous: number; resolved: number };
}

function listAttachments(rows: ExportRow[], resolution: AttachmentResolution) {
  const missing: ImportSummary["lists"]["missingAttachments"] = [];
  const ambiguous: ImportSummary["lists"]["ambiguousAttachments"] = [];
  for (const row of rows) {
    const cell = resolution.cells.get(row.row);
    if (cell?.status === "missing") {
      missing.push({ cell: row.attachment, row: row.row, sameTimestampFiles: cell.hints });
    }
    if (cell?.status === "ambiguous") {
      ambiguous.push({ candidates: cell.candidates, row: row.row });
    }
  }
  return { ambiguous, missing };
}

/** Pure import plan: identical inputs and archive revision give one digest. */
export function planImport(
  state: ArchiveState,
  parsed: ParsedExport,
  exportSha256: string,
  files: AttachmentFile[],
): PlannedImport {
  const resolution = resolveAttachments(parsed.rows, files);
  const rowSha = new Map<number, string>();
  for (const [row, cell] of resolution.cells) {
    if (cell.file !== null) rowSha.set(row, cell.file.sha256);
  }
  const items = planItems(state, parsed, exportSha256, rowSha);
  const inputs = associationInputs(parsed.rows, items.rowItems, resolution);
  const planned = planAssociations(state, inputs, exportSha256);
  const plan: ImportPlan = {
    ambiguities: items.ambiguities,
    associations: planned.associations,
    blobs: planned.blobs,
    copyOriginal: !state.originals.has(exportSha256),
    items: items.items,
    observations: items.observations,
  };
  const attachmentLists = listAttachments(parsed.rows, resolution);
  const summary: ImportSummary = {
    attachmentRowResolution: countStatuses(resolution.cells.values()),
    attachmentRows: resolution.cells.size,
    chatFiles: files.length,
    lists: {
      ambiguousAttachments: attachmentLists.ambiguous,
      ambiguousMessageLinks: items.ambiguousLinks,
      ambiguousMessages: items.ambiguousMessages,
      ambiguousWebLinks: resolution.webLinks.ambiguous,
      missingAttachments: attachmentLists.missing,
      nearMatches: items.nearMatches,
      unreferencedFiles: resolution.unreferenced,
    },
    messageRows: parsed.rows.length,
    observations: items.counts,
    planned: {
      associations: countStatuses(plan.associations),
      blobBytes: plan.blobs.reduce((total, blob) => total + blob.size, 0),
      blobs: plan.blobs.length,
      ambiguities: plan.ambiguities.length,
      copyOriginal: plan.copyOriginal,
      items: plan.items.length,
      observations: plan.observations.length,
    },
    variant: parsed.variant,
    webLinks: {
      ambiguous: resolution.webLinks.ambiguous.length,
      resolved: resolution.webLinks.resolved.length,
    },
  };
  const digest = sha256(
    JSON.stringify({ exportSha256, plan, revision: state.revision }),
  );
  return { digest, plan, summary };
}

export function planIsEmpty(plan: ImportPlan): boolean {
  return (
    plan.items.length === 0 &&
    plan.ambiguities.length === 0 &&
    plan.observations.length === 0 &&
    plan.associations.length === 0 &&
    plan.blobs.length === 0
  );
}
