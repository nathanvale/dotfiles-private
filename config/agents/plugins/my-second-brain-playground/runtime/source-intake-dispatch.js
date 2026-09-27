#!/usr/bin/env bun
// @bun

// packages/source-intake-dispatch/src/main.ts
import { lstatSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
var REFUSAL = {
  message: "Request denied. Stage Manager must verify the private grant before retrying.",
  nextAction: "Ask Stage Manager to verify the private grant and issue a matching request.",
  outcome: "refused"
};
var REDACTED_PROJECTION = { outcome: "redacted", projection: { receipt: "[REDACTED]" } };
var CLASSIFICATION_FIELDS = new Set(["displayName", "mimeType", "modifiedTime", "sizeBytes"]);
var GRANT_KEYS = ["allowedFields", "opaqueItemRef", "provider", "purpose", "receiptPath"];
var REQUEST_KEYS = ["opaqueItemRef", "provider", "purpose", "requestedFields"];
var OPAQUE_ITEM_REF = /^[a-z0-9][a-z0-9-]{0,63}$/;
var USAGE = `Usage:
  source-intake-dispatch --help
  source-intake-dispatch --redacted <status|evaluation>
  source-intake-dispatch <private-grant.json> <private-request.json>

The manifest and request are private JSON. A matching Luna classification request
returns only its granted flat metadata projection. A mismatch exits 3 with the
fixed redacted refusal. Status and evaluation receive the fixed redacted result.
`;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isFieldList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString) && new Set(value).size === value.length;
}
function hasOnlyKeys(record, keys) {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}
function asGrant(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, GRANT_KEYS))
    return null;
  if (!isNonEmptyString(value.opaqueItemRef) || !OPAQUE_ITEM_REF.test(value.opaqueItemRef) || !isNonEmptyString(value.provider) || !isNonEmptyString(value.purpose) || !isNonEmptyString(value.receiptPath) || !isFieldList(value.allowedFields) || !value.allowedFields.every((field) => CLASSIFICATION_FIELDS.has(field))) {
    return null;
  }
  return {
    allowedFields: value.allowedFields,
    opaqueItemRef: value.opaqueItemRef,
    provider: value.provider,
    purpose: value.purpose,
    receiptPath: value.receiptPath
  };
}
function asRequest(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, REQUEST_KEYS))
    return null;
  if (!isNonEmptyString(value.opaqueItemRef) || !OPAQUE_ITEM_REF.test(value.opaqueItemRef) || !isNonEmptyString(value.provider) || !isNonEmptyString(value.purpose) || !isFieldList(value.requestedFields)) {
    return null;
  }
  return {
    opaqueItemRef: value.opaqueItemRef,
    provider: value.provider,
    purpose: value.purpose,
    requestedFields: value.requestedFields
  };
}
function parseJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function expectedReceiptPath(opaqueItemRef) {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  if (!isAbsolute(stateHome))
    return null;
  return join(realpathSync(stateHome), "my-second-brain-playground", "drive-inbox-filing", "items", opaqueItemRef, "classification-metadata.json");
}
function isBoundReceiptPath(grant) {
  const expected = expectedReceiptPath(grant.opaqueItemRef);
  if (expected === null || resolve(grant.receiptPath) !== expected)
    return false;
  const expectedParent = dirname(expected);
  return !lstatSync(expected).isSymbolicLink() && realpathSync(expectedParent) === expectedParent && realpathSync(grant.receiptPath) === expected;
}
function isAuthorized(grant, request) {
  return grant.provider === "luna" && grant.purpose === "classification" && grant.opaqueItemRef === request.opaqueItemRef && grant.provider === request.provider && grant.purpose === request.purpose && request.requestedFields.every((field) => grant.allowedFields.includes(field));
}
function isMetadataScalar(value) {
  return typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}
function project(receipt, requestedFields) {
  if (!isRecord(receipt) || !requestedFields.every((field) => Object.hasOwn(receipt, field) && isMetadataScalar(receipt[field])))
    return null;
  return Object.fromEntries(requestedFields.map((field) => [field, receipt[field]]));
}
function refuse() {
  process.stdout.write(`${JSON.stringify(REFUSAL)}
`);
  return 3;
}
function runSourceIntakeDispatch(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.length === 2 && args[0] === "--redacted" && (args[1] === "status" || args[1] === "evaluation")) {
    process.stdout.write(`${JSON.stringify(REDACTED_PROJECTION)}
`);
    return 0;
  }
  if (args.length !== 2)
    return refuse();
  const [grantPath, requestPath] = args;
  if (grantPath === undefined || requestPath === undefined)
    return refuse();
  try {
    const grant = asGrant(parseJson(grantPath));
    const request = asRequest(parseJson(requestPath));
    if (grant === null || request === null || !isBoundReceiptPath(grant) || !isAuthorized(grant, request))
      return refuse();
    const projection = project(parseJson(grant.receiptPath), request.requestedFields);
    if (projection === null)
      return refuse();
    process.stdout.write(`${JSON.stringify({ outcome: "allowed", projection })}
`);
    return 0;
  } catch {
    return refuse();
  }
}
if (import.meta.main)
  process.exitCode = runSourceIntakeDispatch(process.argv.slice(2));
