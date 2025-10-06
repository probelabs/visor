# Schema Coverage – Next Phase

This PR tracks follow-up work to expand the generated JSON Schema to cover all provider-specific keys and options without relying on runtime generation.

Planned tasks:
- Validate and document provider-specific fields (ai, log, command, http, http_input, http_client, claude-code).
- Ensure additionalProperties is set appropriately per object; allow `x-` extensions.
- Keep human-friendly error messages while surfacing unknown keys via Ajv warnings.

This doc will be updated as changes land.
