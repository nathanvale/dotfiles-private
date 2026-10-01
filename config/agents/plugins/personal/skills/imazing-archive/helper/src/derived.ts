import { toCsv } from "./csv.ts";
import type {
  ArchiveState,
  AssociationRecord,
  DecisionRecord,
  ItemRecord,
} from "./model.ts";

/** Review state the derived views show; decisions override detection. */
function reviewColumns(
  decision: DecisionRecord | undefined,
  association: AssociationRecord | undefined,
): string[] {
  return [
    decision?.imageType ?? association?.detectedImageType ?? "",
    decision?.containsMeme ?? "unknown",
    decision?.visualReview ?? "pending",
    decision?.albumSelection ?? "undecided",
  ];
}

const REVIEW_HEADER = [
  "image_type",
  "contains_meme",
  "visual_review",
  "album_selection",
];

function blobPathFor(state: ArchiveState, sha: string | null): string {
  return sha === null ? "" : (state.blobs.get(sha)?.path ?? "");
}

function sortedItems(state: ArchiveState): ItemRecord[] {
  return [...state.items.values()].sort(
    (left, right) =>
      left.messageDate.localeCompare(right.messageDate) ||
      left.itemKey.localeCompare(right.itemKey),
  );
}

function messagesCsv(state: ArchiveState): string {
  const header = [
    "item_key",
    "message_id",
    "message_date",
    "direction",
    "sender_name",
    "service",
    "status",
    "text",
    "replying_to",
    "reactions",
    "edited_date",
    "deleted_date",
    "attachment_name",
    "attachment_status",
    "blob_path",
    ...REVIEW_HEADER,
  ];
  const rows = sortedItems(state).map((item) => {
    const cell = state.associations.get(`${item.itemKey}|cell`);
    return [
      item.itemKey,
      item.messageId ?? "",
      item.messageDate,
      item.direction,
      item.senderName,
      item.service,
      item.status,
      item.text,
      item.replyingTo,
      item.reactions ?? "",
      item.editedDate,
      item.deletedDate ?? "",
      item.attachment?.originalName ?? "",
      cell?.status ?? "",
      blobPathFor(state, cell?.sha256 ?? null),
      ...reviewColumns(state.decisions.get(item.itemKey), cell),
    ];
  });
  return toCsv(header, rows);
}

function attachmentsCsv(state: ArchiveState): string {
  const header = [
    "association_key",
    "item_key",
    "source",
    "status",
    "strategy",
    "media_kind",
    "original_name",
    "exported_path",
    "sha256",
    "blob_path",
    "candidates_json",
  ];
  const rows = [...state.associations.values()]
    .sort((left, right) =>
      left.associationKey.localeCompare(right.associationKey),
    )
    .map((record) => [
      record.associationKey,
      record.itemKey,
      record.source,
      record.status,
      record.strategy,
      record.mediaKind,
      record.originalName ?? "",
      record.exportedPath ?? "",
      record.sha256 ?? "",
      blobPathFor(state, record.sha256),
      JSON.stringify(record.candidates),
    ]);
  return toCsv(header, rows);
}

/** Resolved images whose item has no `reviewed` decision yet. */
export function pendingImages(state: ArchiveState): AssociationRecord[] {
  return [...state.associations.values()]
    .filter(
      (record) =>
        record.status === "resolved" &&
        record.mediaKind === "image" &&
        state.decisions.get(record.itemKey)?.visualReview !== "reviewed",
    )
    .sort((left, right) => left.associationKey.localeCompare(right.associationKey));
}

function pendingCsv(state: ArchiveState): string {
  const header = [
    "item_key",
    "message_date",
    "direction",
    "original_name",
    "sha256",
    "blob_path",
    ...REVIEW_HEADER,
  ];
  const rows = pendingImages(state).map((record) => {
    const item = state.items.get(record.itemKey);
    return [
      record.itemKey,
      item?.messageDate ?? "",
      item?.direction ?? "",
      record.originalName ?? "",
      record.sha256 ?? "",
      blobPathFor(state, record.sha256),
      ...reviewColumns(state.decisions.get(record.itemKey), record),
    ];
  });
  return toCsv(header, rows);
}

export function derivedFiles(state: ArchiveState): Record<string, string> {
  return {
    "derived/attachments.csv": attachmentsCsv(state),
    "derived/messages.csv": messagesCsv(state),
    "derived/pending-images.csv": pendingCsv(state),
  };
}
