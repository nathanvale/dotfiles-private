export type EffectClass = "inspect" | "repository-local";
export type Outcome = "failed" | "refused" | "success";
export type TransactionState = "completed" | "unchanged" | "unknown";
export type FailureClass =
  | "domain"
  | "internal"
  | "schema"
  | "transient"
  | "usage"
  | null;

export interface Handoff {
  inspect: string[];
  owner: "human" | "operator";
  reason: string;
}

export interface OperationResult {
  causeCode: string;
  commandIdentity: string;
  data: unknown;
  effectClass: EffectClass;
  effects: {
    completed: string[];
    inventoryComplete: boolean;
    remaining: string[];
    uncertain: string[];
  };
  exitCode: 0 | 1 | 2 | 3 | 4 | 75;
  failureClass: FailureClass;
  handoff?: Handoff;
  message: string;
  nextAction?: string;
  outcome: Outcome;
  repairAction: string | null;
  retryable: boolean;
  retryDelayMilliseconds?: number;
  transactionState: TransactionState;
}

/** The archive begins on this local calendar date unless created otherwise. */
export const DEFAULT_START_DATE = "2023-10-15";

export const IMAGE_TYPES = [
  "photo",
  "screenshot",
  "screenshot_with_meme",
  "meme",
  "document",
  "gif",
  "sticker",
  "url",
  "other",
  "unknown",
] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const CONTAINS_MEME = ["true", "false", "unknown"] as const;
export const ALBUM_SELECTIONS = ["undecided", "selected", "rejected"] as const;
export type MediaKind = "attachment" | "audio" | "image" | "video" | "web-link";
export type Direction = "incoming" | "notification" | "outgoing";
export type Variant = "imazing-15" | "imazing-18";

/** One CSV data row, normalised across both iMazing variants. */
export interface ExportRow {
  attachment: string;
  attachmentType: string;
  deletedDate: string | null;
  deliveredDate: string;
  direction: Direction;
  editedDate: string;
  messageDate: string;
  messageId: string | null;
  reactions: string | null;
  readDate: string;
  replyingTo: string;
  row: number;
  senderId: string;
  senderName: string;
  service: string;
  status: string;
  text: string;
}

export interface ParsedExport {
  chatSession: string;
  rows: ExportRow[];
  variant: Variant;
}

/** One file under an attachments root, already hashed. */
export interface AttachmentFile {
  /** File name after the `<timestamp> - <chat> - ` prefix. */
  exportedName: string;
  relativePath: string;
  sha256: string;
  size: number;
  timestamp: string;
}

export interface ItemRecord {
  attachment: { originalName: string; type: string } | null;
  chatSession: string;
  deletedDate: string | null;
  deliveredDate: string;
  direction: Direction;
  editedDate: string;
  fingerprint: string;
  firstSeen: { exportSha256: string; row: number };
  itemKey: string;
  messageDate: string;
  messageId: string | null;
  part: string | null;
  reactions: string | null;
  readDate: string;
  recordVersion: 1;
  replyingTo: string;
  senderId: string;
  senderName: string;
  service: string;
  status: string;
  text: string;
}

/** Both sides of an unresolved Message ID to fingerprint link. */
export interface AmbiguityRecord {
  exportSha256: string;
  itemKeys: string[];
  reason: "message-id-fingerprint";
  recordVersion: 1;
  row: number;
}

export type ObservationStrategy =
  | "ambiguous-fingerprint"
  | "fingerprint-match"
  | "fingerprint-new"
  | "message-id-linked-fingerprint"
  | "message-id-match"
  | "message-id-new";

export interface ObservationRecord {
  ambiguousCandidates: string[];
  exportSha256: string;
  itemKey: string | null;
  messageId: string | null;
  part: string | null;
  recordVersion: 1;
  row: number;
  strategy: ObservationStrategy;
}

export type AssociationStatus = "ambiguous" | "missing" | "resolved";

export interface AssociationRecord {
  associationKey: string;
  candidates: string[];
  detectedImageType: ImageType;
  exportSha256: string;
  exportedPath: string | null;
  itemKey: string;
  mediaKind: MediaKind;
  originalName: string | null;
  recordVersion: 1;
  row: number;
  sha256: string | null;
  source: "attachment-cell" | "web-link";
  status: AssociationStatus;
  strategy: "exact" | "none" | "variant-name" | "web-link-timestamp";
}

export interface BlobRecord {
  path: string;
  recordVersion: 1;
  sha256: string;
  size: number;
  sourcePath: string;
}

export interface DecisionRecord {
  albumSelection?: (typeof ALBUM_SELECTIONS)[number] | undefined;
  containsMeme?: (typeof CONTAINS_MEME)[number] | undefined;
  imageType?: ImageType | undefined;
  itemKey: string;
  recordVersion: 1;
  recordedAt: string;
  visualReview?: "pending" | "reviewed" | undefined;
}

export interface ArchiveState {
  ambiguities: Map<string, Set<string>>;
  associations: Map<string, AssociationRecord>;
  blobs: Map<string, BlobRecord>;
  decisions: Map<string, DecisionRecord>;
  fingerprintIndex: Map<string, string[]>;
  idIndex: Map<string, string>;
  items: Map<string, ItemRecord>;
  linkedItems: Set<string>;
  /** `<export sha>:<row>` to the row's item key, or null when held. */
  observedRows: Map<string, string | null>;
  originals: Set<string>;
  revision: string;
}

export interface ImportPlan {
  ambiguities: AmbiguityRecord[];
  associations: AssociationRecord[];
  blobs: BlobRecord[];
  copyOriginal: boolean;
  items: ItemRecord[];
  observations: ObservationRecord[];
}
