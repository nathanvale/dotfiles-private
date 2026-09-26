# Source Intake dispatch

Project a granted private receipt into a delegated classifier input without
passing the receipt path or its other records to that classifier. This is a
supported-path guard, not filesystem isolation.

## Command

```sh
source-intake-dispatch --help
source-intake-dispatch --redacted status
source-intake-dispatch --redacted evaluation
source-intake-dispatch <private-grant.json> <private-request.json>
```

The grant and request stay in private runtime state. The grant has exactly
`opaqueItemRef`, `provider`, `purpose`, `allowedFields`, and `receiptPath`.
The request has exactly `opaqueItemRef`, `provider`, `purpose`, and
`requestedFields`. The opaque reference is a lowercase letter or number plus
hyphens, and identifies the sole receipt location:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/my-second-brain-playground/drive-inbox-filing/items/<opaqueItemRef>/classification-metadata.json
```

Only `luna` with purpose `classification` is supported. Grant and requested
fields must come from this closed metadata list: `displayName`, `mimeType`,
`modifiedTime`, and `sizeBytes`. The metadata file is one flat JSON object;
each projected value is a string or finite number.

On success, exit 0 and emit one JSON projection containing exactly the
requested fields. Status and evaluation emit the fixed redacted projection.
Every invalid, mismatched, missing, or unsupported request exits 3 with this
fixed JSON refusal and empty stderr:

```json
{"message":"Request denied. Stage Manager must verify the private grant before retrying.","nextAction":"Ask Stage Manager to verify the private grant and issue a matching request.","outcome":"refused"}
```

Vault Steward is not a command recipient. It receives only Nathan-approved
note content from the foreground Steward or Stage Manager.
