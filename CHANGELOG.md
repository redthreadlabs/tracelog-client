# Changelog

## 2.1.3

- deps: `@redthreadlabs/tracelog-schema` ^0.5.1 -> ^0.6.0.
- The origin a batch carries sets `schema` to the schema's `SCHEMA_VERSION`
  ("0.6.0"), so a reader knows which fields to expect. It overrides any
  `schema` the host's `getOrigin` returns.
