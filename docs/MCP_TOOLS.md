# MCP tool catalogue

Generated from `tools/list` using `scripts/mcp-smoke.py --catalogue docs/evidence/tool-catalogue.json` and `python3 scripts/document-tools.py`. The snapshot contains complete input/output schemas; this page includes examples and operation boundaries. Prompts and resources are separately discoverable.

## Contracts

Every input is a closed JSON object: unknown top-level fields are rejected with JSON-RPC invalid parameters. Required fields, enum values and bounds below are executable schemas. Values marked as examples or placeholders must be replaced with retrieved identifiers/paths. Secrets belong in transport/server configuration, never tool arguments.

Legacy retrieval tools retain their original text/resource or structured search results. New model/project/terminology tools return `success`, `result`, and `error`. `success:true` means the operation returned a report; inspect its `status`, `valid`, `warnings` and executed checks before claiming validation. Failures use `{ "success": false, "result": null, "error": { "code": "REVISION_CONFLICT", "message": "The artefact changed. Read the current revision before retrying.", "retryable": false } }`. Upstream dependency errors do not expose credentials or raw error bodies.

`model_artifact_save` always creates a DRAFT revision. Project creation, artifact saving, branch creation and hosted review requests write persistent state and require deployment write enablement and, in OIDC mode, an authorized draft-write scope or role. No tool approves/releases a model. Read-only tools may contact configured external servers. See [capabilities](../CAPABILITIES.md) for partial or unavailable checks.

## `aql_validate`

Parse AQL with the native ANTLR engine and return its typed syntax tree and normalized query. Model compatibility, path validation and execution remain separate; no CDR is required.

External dependency: configured native openEHR engine; no terminology server or CDR required.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2097152
    }
  },
  "required": [
    "content"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "aql_validate",
  "arguments": {
    "content": "SELECT e/ehr_id/value FROM EHR e"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `archetype_validate`

Validate ADL 2 grammar, AOM constraints and the declared supported RM profile with the configured native engine. Dependencies are explicit exact versions; no network retrieval or approval.

External dependency: configured native openEHR engine; no terminology server or CDR required.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2097152
    },
    "dependencies": {
      "type": "array",
      "default": [],
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "identifier",
          "content"
        ],
        "properties": {
          "identifier": {
            "type": "string",
            "minLength": 2,
            "maxLength": 300
          },
          "content": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2097152
          }
        }
      },
      "maxItems": 64
    }
  },
  "required": [
    "content"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "archetype_validate",
  "arguments": {
    "content": "<ADL 2 source>"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `ckm_archetype_get`

Retrieve the full definition of an Archetype from CKM, serialized in a specified format.

Use this tool after you have identified a candidate archetype (usually from the `ckm_archetype_search` tool),
or when you already know the archetype CID (e.g. "1013.1.7850") or archetype-id (e.g. "openEHR-EHR-OBSERVATION.blood_pressure.v1").
It fetches the *full archetype definition* from CKM so an LLM can process it according to relevant guides, e.g.:
- understand the structure and semantics of nodes/attributes,
- extract constraints, translations, and terminology bindings,
- generate templates or implementation guidance,
- or cite the definition content in downstream reasoning.
When guides are not yet available, use the `guide_search` tool to discover them applicable to the archetype and the user request.
Returned content and formats:
- "adl": ADL source text (best for detailed archetype semantics and constraints)
- "xml": XML representation (similar to "adl", but helpful when consuming via XML tooling)
- "mindmap": mindmap form (useful for quick visual overview)

External dependency: configured CKM REST API.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "identifier": {
      "type": "string",
      "description": "Archetype CID identifier (e.g. \"1013.1.7850\") or archetype-id (e.g. \"openEHR-EHR-OBSERVATION.blood_pressure.v1\")."
    },
    "format": {
      "type": "string",
      "description": "Desired representation (case-insensitive); see the returned content/formats above for what each value means. Defaults to \"adl\".",
      "default": "adl",
      "enum": [
        "adl",
        "xml",
        "mindmap"
      ]
    },
    "ckm": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "identifier"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "ckm_archetype_get",
  "arguments": {
    "identifier": "openEHR-EHR-OBSERVATION.body_weight.v2",
    "format": "adl"
  }
}
```

Output: MCP content blocks (text or embedded resources), except `ckm_sources`, which returns the default source name and configured source URL map.

## `ckm_archetype_search`

Search and discover candidate openEHR Archetypes in the Clinical Knowledge Manager (CKM).

Use this tool when you need to *discover* candidate archetypes before fetching their full definitions.
It is typically the first step in an LLM workflow:
1) Search by a domain keyword (e.g. "blood pressure", "medication", "problem list")
2) Inspect the returned metadata for plausible matches
3) Take the returned CKM identifier (CID) and call `ckm_archetype_get` tool to retrieve the full archetype definition.

External dependency: configured CKM REST API.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "keyword": {
      "type": "string",
      "description": "Query search string (one or multiple words); wildcards `*` supported; prefer meaningful clinical terms over internal codes, e.g. \"blood pressure\", \"medication\", \"diabetes\", \"body weight\"."
    },
    "maxResults": {
      "type": "integer",
      "description": "The maximum number of result items to be returned; defaults to 20 and must be between 1 and 50 (values outside that range are rejected, not clamped).",
      "default": 20,
      "minimum": 1,
      "maximum": 50
    },
    "requireAllSearchWords": {
      "type": "boolean",
      "description": "Determines if the search should match all provided keywords (true) or any of them (false); defaults to true.",
      "default": true
    },
    "rmClass": {
      "type": "string",
      "description": "Optional RM class filter on the archetype-id (e.g. `COMPOSITION`, `OBSERVATION`, `CLUSTER`); case-insensitive; empty (default) = no filter.",
      "default": ""
    },
    "ckm": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "keyword"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "ckm_archetype_search",
  "arguments": {
    "keyword": "body weight",
    "maxResults": 5
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "items",
    "total"
  ],
  "properties": {
    "items": {
      "type": "array",
      "description": "List of CKM Archetypes matching the search criteria",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "cid",
          "score"
        ],
        "properties": {
          "cid": {
            "type": "string",
            "description": "CKM Archetype identifier"
          },
          "archetypeId": {
            "type": "string"
          },
          "name": {
            "type": "string",
            "description": "Archetype display or concept name"
          },
          "projectName": {
            "type": "string",
            "description": "Project name where the Archetype belongs to"
          },
          "status": {
            "type": "string"
          },
          "revision": {
            "type": "string"
          },
          "creationTime": {
            "type": "string",
            "description": "ISO 8601 or epoch-ms string from CKM"
          },
          "modificationTime": {
            "type": "string",
            "description": "ISO 8601 or epoch-ms string from CKM"
          },
          "score": {
            "type": "integer",
            "description": "Score of the match, based on the search keywords"
          }
        }
      }
    },
    "total": {
      "type": "integer",
      "minimum": 0,
      "description": "Upstream CKM match count for the keyword search (`X-Total-Count`), falling back to the number of matches when that header is absent or malformed. When `rmClass` is supplied the count reflects the locally filtered matches instead. May exceed items.length."
    }
  }
}
```

## `ckm_federated_search`

Search up to eight configured CKMs with independent source provenance, bounded lexical/status ranking and explicit per-source failures/truncation. An empty source list selects all configured sources only when there are at most eight. Result totals describe retrieved windows, never an asserted global CKM count. Credentials and source URLs are deployment configuration.

External dependency: configured CKM REST API.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "archetype",
        "template"
      ]
    },
    "keyword": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "sources": {
      "type": "array",
      "default": [],
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "maxItems": 8,
      "uniqueItems": true
    },
    "maxResults": {
      "type": "integer",
      "default": 20,
      "minimum": 1,
      "maximum": 50
    }
  },
  "required": [
    "kind",
    "keyword"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "ckm_federated_search",
  "arguments": {
    "kind": "archetype",
    "keyword": "body weight",
    "sources": [
      "default"
    ],
    "maxResults": 5
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "items",
    "total",
    "total_scope",
    "status",
    "all_sources_responded",
    "truncated",
    "source_results",
    "ranking",
    "scope"
  ],
  "properties": {
    "items": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "source",
          "source_url",
          "kind",
          "cid",
          "score"
        ],
        "properties": {
          "source": {
            "type": "string"
          },
          "source_url": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "enum": [
              "archetype",
              "template"
            ]
          },
          "cid": {
            "type": "string"
          },
          "score": {
            "type": "integer"
          },
          "archetypeId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "projectName": {
            "type": "string"
          },
          "status": {
            "type": "string"
          },
          "revision": {
            "type": "string"
          },
          "version": {
            "type": "string"
          },
          "creationTime": {
            "type": "string"
          },
          "modificationTime": {
            "type": "string"
          }
        }
      }
    },
    "total": {
      "type": "integer",
      "minimum": 0
    },
    "total_scope": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "COMPLETE",
        "PARTIAL",
        "UNAVAILABLE"
      ]
    },
    "all_sources_responded": {
      "type": "boolean"
    },
    "truncated": {
      "type": "boolean"
    },
    "source_results": {
      "type": "array",
      "minItems": 1,
      "maxItems": 8,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "source",
          "status",
          "reported_total",
          "returned",
          "error"
        ],
        "properties": {
          "source": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "PASS",
              "FAILED",
              "NOT_EXECUTED"
            ]
          },
          "reported_total": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0
          },
          "returned": {
            "type": "integer",
            "minimum": 0
          },
          "error": {
            "type": [
              "string",
              "null"
            ],
            "enum": [
              null,
              "FEDERATION_TIME_BUDGET",
              "CKM_SOURCE_UNAVAILABLE"
            ]
          }
        }
      }
    },
    "ranking": {
      "type": "string"
    },
    "scope": {
      "type": "string"
    }
  }
}
```

## `ckm_sources`

List configured CKMs. Pass a source name as the optional ckm argument on CKM tools.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "ckm_sources",
  "arguments": {}
}
```

Output: MCP content blocks (text or embedded resources), except `ckm_sources`, which returns the default source name and configured source URL map.

## `ckm_template_get`

Retrieve the full definition of an openEHR Template (OET or OPT) from CKM by its identifier, serialized in a specified format.

Use this tool to *retrieve* an openEHR Template from CKM after you have identified a candidate template (usually from the `ckm_template_search` tool),
or when you already know the template CID (e.g. "1013.26.244").
It fetches the *full Template definition* from CKM so an LLM can process it according to relevant guides, e.g.:
- understand the structure and semantics of nodes/attributes,
- extract constraints, translations, and terminology bindings,
- or cite the definition content in downstream reasoning.
When guides are not yet available, use the `guide_search` tool to discover them applicable to the Template and the user request.
Returned content and formats:
- "oet": Template source (XML) - the unflattened version (design-time template).
- "opt": Operational Template (XML) - the flattened version of the Template, containing all archetype constraints.

External dependency: configured CKM REST API.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "identifier": {
      "type": "string",
      "description": "Template CID identifier (e.g. \"1013.26.244\")."
    },
    "format": {
      "type": "string",
      "description": "Desired representation; see the returned content/formats above for what each value means. Defaults to \"oet\".",
      "default": "oet",
      "enum": [
        "oet",
        "opt"
      ]
    },
    "ckm": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "identifier"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "ckm_template_get",
  "arguments": {
    "identifier": "1013.26.1",
    "format": "oet"
  }
}
```

Output: MCP content blocks (text or embedded resources), except `ckm_sources`, which returns the default source name and configured source URL map.

## `ckm_template_search`

Search for and discover candidate openEHR Templates in the Clinical Knowledge Manager (CKM) matching a given criteria.

Use this tool when you need to *discover* candidate openEHR Templates (OET or OPT) before fetching their full definitions.
It is typically the first step in an LLM workflow:
1) Search by one or more domain keywords (e.g. "vital signs", "discharge summary")
2) Inspect the returned metadata for plausible matches
3) Take the returned CKM identifier (CID) and call `ckm_template_get` tool to retrieve the content.

External dependency: configured CKM REST API.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "keyword": {
      "type": "string",
      "description": "Query search string, one or multiple words, wildcards `*` supported."
    },
    "maxResults": {
      "type": "integer",
      "description": "The maximum number of result items to be returned; defaults to 20 and must be between 1 and 50 (values outside that range are rejected, not clamped).",
      "default": 20,
      "minimum": 1,
      "maximum": 50
    },
    "requireAllSearchWords": {
      "type": "boolean",
      "description": "Determines if the search should match all provided keywords (true) or any of them (false); defaults to true.",
      "default": true
    },
    "ckm": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "keyword"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "ckm_template_search",
  "arguments": {
    "keyword": "encounter",
    "maxResults": 5
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "items",
    "total"
  ],
  "properties": {
    "items": {
      "type": "array",
      "description": "List of CKM Templates matching the search criteria",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "cid",
          "score"
        ],
        "properties": {
          "cid": {
            "type": "string",
            "description": "CKM Template identifier"
          },
          "name": {
            "type": "string",
            "description": "Template display name"
          },
          "projectName": {
            "type": "string",
            "description": "Project name where the Template belongs to"
          },
          "status": {
            "type": "string"
          },
          "version": {
            "type": "string"
          },
          "creationTime": {
            "type": "string",
            "description": "ISO 8601 or epoch-ms string from CKM"
          },
          "modificationTime": {
            "type": "string",
            "description": "ISO 8601 or epoch-ms string from CKM"
          },
          "score": {
            "type": "integer",
            "description": "Score of the match, based on the search keywords"
          }
        }
      }
    },
    "total": {
      "type": "integer",
      "minimum": 0,
      "description": "Upstream CKM match count for the keyword search (`X-Total-Count`), falling back to the number of matches when that header is absent or malformed. May exceed items.length."
    }
  }
}
```

## `examples_get`

Fetch the full content of an openEHR example artefact by canonical URI or by specifying kind and name.

Use this tool to retrieve a curated example. The payload is one of two shapes: for the `aql`, `flat` and
`structured` kinds a Markdown wrapper (`text/markdown`) with a short metadata header — what pattern it
demonstrates, related specs/guides — around a fenced code block; for the `archetypes` kind a native
CKM-published `.adl` file (`text/plain`), with no metadata header and no fence.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "uri": {
      "type": "string",
      "description": "Canonical example URI (openehr://examples/{kind}/{name}). Optional when kind and name are provided.",
      "default": ""
    },
    "kind": {
      "type": [
        "null",
        "string"
      ],
      "description": "Artefact kind (AQL query, FLAT/STRUCTURED JSON payload, or native archetype). Optional when URI is provided.",
      "default": null,
      "enum": [
        "aql",
        "flat",
        "structured",
        "archetypes",
        null
      ]
    },
    "name": {
      "type": "string",
      "description": "Example filename without extension. Optional when URI is provided.",
      "default": ""
    }
  },
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "examples_get",
  "arguments": {
    "uri": "openehr://examples/aql/<name-from-search>"
  }
}
```

Output: MCP content blocks (text or embedded resources), except `ckm_sources`, which returns the default source name and configured source URL map.

## `examples_search`

Search openEHR example artefacts (AQL queries, FLAT/STRUCTURED JSON payloads, native ADL archetypes) and return short snippets plus canonical openehr://examples URIs.

Use this tool to discover curated, ready-to-reference examples that illustrate specific patterns
(e.g. "latest per patient", "time-window", "aggregation", "FLAT vs STRUCTURED pair").
Each hit returns the example's title, kind, canonical URI, and a short snippet so the model can decide which to pull with `examples_get`.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "The query string describing what you need (e.g. \"blood pressure\", \"latest per patient\", \"DV_QUANTITY projection\").\nLeave empty to list all examples in the optional kind filter.",
      "default": ""
    },
    "kind": {
      "type": [
        "null",
        "string"
      ],
      "description": "Optional artefact-kind filter (AQL query, FLAT/STRUCTURED JSON payload, or native archetype). Omit to search all kinds.",
      "default": null,
      "enum": [
        "aql",
        "flat",
        "structured",
        "archetypes",
        null
      ]
    },
    "maxResults": {
      "type": "integer",
      "description": "The maximum number of examples to return; defaults to 10 and must be between 1 and 30 (values outside that range are rejected, not clamped). `total` reports how many examples matched before this cap.",
      "default": 10,
      "minimum": 1,
      "maximum": 30
    },
    "snippetChars": {
      "type": "integer",
      "description": "The maximum length of each returned snippet in characters; defaults to 220 and must be between 80 and 1200 (values outside that range are rejected, not clamped).",
      "default": 220,
      "minimum": 80,
      "maximum": 1200
    }
  },
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "examples_search",
  "arguments": {
    "kind": "aql"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "items",
    "total"
  ],
  "properties": {
    "items": {
      "type": "array",
      "description": "List of matching example snippets and canonical example URIs",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "title",
          "kind",
          "name",
          "resourceUri",
          "snippet",
          "score"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "description": "Example kind: aql | flat | structured | archetypes"
          },
          "name": {
            "type": "string"
          },
          "resourceUri": {
            "type": "string",
            "format": "uri",
            "description": "Canonical example URI in openehr://examples namespace"
          },
          "snippet": {
            "type": "string",
            "description": "Short, task-relevant snippet"
          },
          "score": {
            "type": "integer",
            "description": "Relative match score (higher is better)"
          }
        }
      }
    },
    "total": {
      "type": "integer",
      "minimum": 0,
      "description": "Total matching examples before the maxResults cap is applied; may exceed items.length"
    }
  }
}
```

## `governance_get`

Read authoritative lifecycle state, exact source identity, validation and append-only audit history. Approval of an old revision never approves the current model.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "subject": {
      "type": "string"
    }
  },
  "required": [
    "subject"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "governance_get",
  "arguments": {
    "subject": "<subject-from-prepare>"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `governance_list`

List governed model revisions in a project and the authenticated tenant namespace, with bounded paging.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "count": {
      "type": "integer",
      "default": 25,
      "minimum": 1,
      "maximum": 100
    },
    "offset": {
      "type": "integer",
      "default": 0,
      "minimum": 0,
      "maximum": 10000
    }
  },
  "required": [
    "project"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "governance_list",
  "arguments": {
    "project": "neonatal-care"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `governance_prepare`

Register an exact source revision for governed review. Trusted transport identity is recorded as preparer; caller-supplied author or approval metadata is not accepted.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "path": {
      "type": "string"
    },
    "modelRevision": {
      "type": "string"
    },
    "comment": {
      "type": "string"
    }
  },
  "required": [
    "project",
    "path",
    "modelRevision",
    "comment"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "governance_prepare",
  "arguments": {
    "project": "neonatal-care",
    "path": "templates/admission.oet",
    "modelRevision": "<observed-model-revision>",
    "comment": "Prepare this exact draft for review."
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `governance_reopen_draft`

Reopen a CHANGES_REQUESTED subject as DRAFT. Changed model content must be registered as a new source revision; existing review history is retained.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "subject": {
      "type": "string"
    },
    "expectedSequence": {
      "type": "integer",
      "minimum": 1
    },
    "comment": {
      "type": "string"
    }
  },
  "required": [
    "subject",
    "expectedSequence",
    "comment"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "governance_reopen_draft",
  "arguments": {
    "subject": "<subject-from-prepare>",
    "expectedSequence": 4,
    "comment": "Address the requested changes."
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `governance_request_review`

Request independent human review of the registered revision. Unqualified draft reviews remain explicitly incomplete and cannot be approved or published.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "subject": {
      "type": "string"
    },
    "expectedSequence": {
      "type": "integer",
      "minimum": 1
    },
    "comment": {
      "type": "string"
    }
  },
  "required": [
    "subject",
    "expectedSequence",
    "comment"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "governance_request_review",
  "arguments": {
    "subject": "<subject-from-prepare>",
    "expectedSequence": 2,
    "comment": "Review the exact revision and unresolved findings."
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `governance_validate`

Execute the installed deterministic validation pipeline and append authoritative evidence. New validation evidence requires a new review. Missing/partial stages return the model to DRAFT and prevent approval; model JSON cannot supply validation results.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "subject": {
      "type": "string"
    },
    "expectedSequence": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "subject",
    "expectedSequence"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "governance_validate",
  "arguments": {
    "subject": "<subject-from-prepare>",
    "expectedSequence": 1
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `guide_adl_idiom_lookup`

Lookup ADL idiom snippets for a symptom or pattern to prevent generic prompting.

This tool is a targeted cheatsheet retrieval for common ADL constraint idioms.
Provide the symptom or pattern (e.g. "occurrences vs cardinality", "coded text", "slots") to receive matching examples.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Symptom or pattern string to search within the ADL idioms cheatsheet."
    }
  },
  "required": [
    "pattern"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "guide_adl_idiom_lookup",
  "arguments": {
    "pattern": "occurrences"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "items",
    "total"
  ],
  "properties": {
    "items": {
      "type": "array",
      "description": "Matching ADL idiom snippets",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "title",
          "snippet",
          "resourceUri",
          "section"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "snippet": {
            "type": "string"
          },
          "resourceUri": {
            "type": "string",
            "format": "uri"
          },
          "section": {
            "type": "string"
          }
        }
      }
    },
    "total": {
      "type": "integer",
      "minimum": 0,
      "description": "Total matching idiom sections before the section cap is applied; may exceed items.length"
    }
  }
}
```

## `guide_get`

Fetch the full content of an openEHR guide by its canonical URI or by specifying its category and name.

Use this tool to retrieve an openEHR guide for a specific processing or implementation task around archetypes, templates, AQL, simplified formats, spec digests, or toolchain how-tos.
Such guides describe modelling workflows, best practices, syntax checklists, principal rules, anti-patterns, normative spec digests, and other guidance on demand.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "uri": {
      "type": "string",
      "description": "Canonical guide URI (openehr://guides/{category}/{name}). Optional when category and name are provided.",
      "default": ""
    },
    "category": {
      "type": [
        "null",
        "string"
      ],
      "description": "Guide category (authoring guides for archetypes/templates/AQL/simplified_formats, plus \"specs\" per-document spec digests and \"howto\" toolchain guides). Optional when URI is provided.",
      "default": null,
      "enum": [
        "archetypes",
        "templates",
        "aql",
        "simplified_formats",
        "specs",
        "howto",
        null
      ]
    },
    "name": {
      "type": "string",
      "description": "Guide filename without extension. Optional when URI is provided.",
      "default": ""
    }
  },
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "guide_get",
  "arguments": {
    "category": "howto",
    "name": "spec-lookup"
  }
}
```

Output: MCP content blocks (text or embedded resources), except `ckm_sources`, which returns the default source name and configured source URL map.

## `guide_search`

Search openEHR guides metadata and content to retrieve small, model-ready snippets plus canonical openehr://guides URIs.

Use this tool when you need to locate the right guidance on demand.
It returns short, task-relevant chunks and meta-data so the model can decide which guide to pull next with `guide_get`.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "The query string describing what guidance you need (e.g. \"cardinality vs occurrences\", \"slot constraints\"). Leave empty to search all guides.",
      "default": ""
    },
    "category": {
      "type": [
        "null",
        "string"
      ],
      "description": "Optional guide category filter. Categories: authoring guides for archetypes/templates/AQL/simplified_formats, plus \"specs\" (per-document openEHR spec digests) and \"howto\" (toolchain how-to guides). Omit to search all categories.",
      "default": null,
      "enum": [
        "archetypes",
        "templates",
        "aql",
        "simplified_formats",
        "specs",
        "howto",
        null
      ]
    },
    "taskType": {
      "type": [
        "null",
        "string"
      ],
      "description": "Optional task hint (e.g. \"lint\", \"review\", \"refactor\", \"author\"). When supplied it adds a small ranking boost to guides whose title, abstract, or indexed headings mention it. It only reorders guides the query already matched: it never filters, and never makes a guide the query did not match appear in the results.",
      "default": null
    },
    "maxResults": {
      "type": "integer",
      "description": "The maximum number of guides to return; defaults to 10 and must be between 1 and 50 (values outside that range are rejected, not clamped). `total` reports how many guides matched before this cap.",
      "default": 10,
      "minimum": 1,
      "maximum": 50
    },
    "snippetChars": {
      "type": "integer",
      "description": "The maximum length of each returned snippet in characters; defaults to 220 and must be between 80 and 1200 (values outside that range are rejected, not clamped).",
      "default": 220,
      "minimum": 80,
      "maximum": 1200
    },
    "topCandidates": {
      "type": "integer",
      "description": "Retained for backward compatibility and no longer limits what is searched. Every\nguide in scope is scored over its full body text, so recall does not depend on\nthis value.",
      "default": 24,
      "minimum": 1
    }
  },
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "guide_search",
  "arguments": {
    "query": "cardinality"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "items",
    "total"
  ],
  "properties": {
    "items": {
      "type": "array",
      "description": "List of matching guide snippets and canonical guide URIs",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "title",
          "category",
          "name",
          "resourceUri",
          "snippet",
          "score"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "category": {
            "type": "string",
            "description": "Guide category: archetypes | templates | aql | simplified_formats | specs | howto"
          },
          "name": {
            "type": "string"
          },
          "resourceUri": {
            "type": "string",
            "format": "uri",
            "description": "Canonical guide URI in openehr://guides namespace"
          },
          "snippet": {
            "type": "string",
            "description": "Short, task-relevant snippet"
          },
          "score": {
            "type": "integer",
            "description": "Relative match score for sorting (higher is better)"
          }
        }
      }
    },
    "total": {
      "type": "integer",
      "minimum": 0,
      "description": "Total number of guides that matched the query, counted before the `maxResults` cap; may exceed items.length. Raise `maxResults` to see more of them."
    }
  }
}
```

## `model_artifact_get`

Read an artefact or its immutable historical revision.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "path": {
      "type": "string"
    },
    "revision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "path"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_artifact_get",
  "arguments": {
    "project": "neonatal-care",
    "path": "requirements/admission.md"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_artifact_history`

Read artefact revision history, including tombstones.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "path": {
      "type": "string"
    }
  },
  "required": [
    "project",
    "path"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_artifact_history",
  "arguments": {
    "project": "neonatal-care",
    "path": "requirements/admission.md"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_artifact_import`

Preserve an external file's exact bytes as a create-only original with protected platform provenance. Requires model write access and a configured audit ledger. Idempotent per caller, project, filename, bytes and source claims. External origin remains caller-declared. Never approves, publishes, converts or extracts the source.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "sourceClaims": {
      "type": [
        "object",
        "null"
      ],
      "default": null,
      "additionalProperties": false,
      "properties": {
        "source_system": {
          "type": "string",
          "maxLength": 1000
        },
        "tool_version": {
          "type": "string",
          "maxLength": 1000
        },
        "external_identifier": {
          "type": "string",
          "maxLength": 1000
        },
        "external_revision": {
          "type": "string",
          "maxLength": 1000
        },
        "exported_at": {
          "type": "string",
          "maxLength": 30
        },
        "licence": {
          "type": "string",
          "maxLength": 1000
        },
        "copyright": {
          "type": "string",
          "maxLength": 1000
        }
      }
    },
    "project": {
      "type": "string"
    },
    "filename": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "contentBase64": {
      "type": "string",
      "minLength": 4,
      "maxLength": 2796204
    },
    "declaredType": {
      "type": "string",
      "default": "UNKNOWN",
      "enum": [
        "ADL_ARCHETYPE",
        "ADL_TEMPLATE",
        "OET_TEMPLATE",
        "OPT",
        "WEB_TEMPLATE",
        "DESIGNER_AUTHORING_JSON",
        "CANONICAL_COMPOSITION",
        "FLAT_COMPOSITION",
        "STRUCTURED_COMPOSITION",
        "TERMINOLOGY_ARTEFACT",
        "MODEL_PACKAGE",
        "OTHER",
        "UNKNOWN"
      ]
    }
  },
  "required": [
    "project",
    "filename",
    "contentBase64"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_artifact_import",
  "arguments": {
    "project": "modelling-demo",
    "filename": "example.xml",
    "contentBase64": "PHgvPg==",
    "declaredType": "UNKNOWN"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_artifact_provenance`

Verify imported bytes against the exact repository revision and protected audit receipt. Reports real transport identity separately from unverified source claims; this is not clinical approval.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "importId": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    }
  },
  "required": [
    "project",
    "importId"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_artifact_provenance",
  "arguments": {
    "project": "modelling-demo",
    "importId": "<import-id-from-receipt>"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_artifact_save`

Save a DRAFT artefact with optimistic concurrency and authorized write access. Pass the previous revision when replacing an artefact; null only creates.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "metadata": {
      "type": [
        "object",
        "null"
      ],
      "default": null,
      "additionalProperties": true
    },
    "project": {
      "type": "string"
    },
    "path": {
      "type": "string"
    },
    "content": {
      "type": "string",
      "maxLength": 2097152
    },
    "expectedRevision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "path",
    "content"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_artifact_save",
  "arguments": {
    "project": "neonatal-care",
    "path": "requirements/admission.md",
    "content": "Requirement: record birth weight.",
    "expectedRevision": null
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_branch_create`

Create a Git branch from a reachable revision. Does not switch the active deployment branch. Requires write access.

External dependency: configured Git remote or hosting API for hosted repository operations.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "branch": {
      "type": "string",
      "maxLength": 200
    },
    "baseRevision": {
      "type": "string"
    }
  },
  "required": [
    "branch",
    "baseRevision"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_branch_create",
  "arguments": {
    "branch": "draft/admission",
    "baseRevision": "<reachable-base-sha>"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_diff`

Compare a bounded XML projection and return structured changes for explicit attributes/text, identifiers, paths, cardinalities, terminology, language and other classified fields. Uniquely identifiable moves are reported as `moved`; ambiguous repeated identities remain separate additions/removals. Inherited constraints, dependency semantics and full openEHR semantic equivalence are not resolved.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "before": {
      "type": "string",
      "maxLength": 2097152
    },
    "after": {
      "type": "string",
      "maxLength": 2097152
    }
  },
  "required": [
    "before",
    "after"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_diff",
  "arguments": {
    "before": "<a min=\"0\"/>",
    "after": "<a min=\"1\"/>"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_import_inspect`

Inspect exact base64-encoded source bytes without writes. Content markers and declarations are separate; Designer .t.json is never assumed to be OET, OPT or Web Template. Does not perform conformance validation or contact an external tool.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "filename": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "contentBase64": {
      "type": "string",
      "minLength": 4,
      "maxLength": 2796204
    },
    "declaredType": {
      "type": "string",
      "default": "UNKNOWN",
      "enum": [
        "ADL_ARCHETYPE",
        "ADL_TEMPLATE",
        "OET_TEMPLATE",
        "OPT",
        "WEB_TEMPLATE",
        "DESIGNER_AUTHORING_JSON",
        "CANONICAL_COMPOSITION",
        "FLAT_COMPOSITION",
        "STRUCTURED_COMPOSITION",
        "TERMINOLOGY_ARTEFACT",
        "MODEL_PACKAGE",
        "OTHER",
        "UNKNOWN"
      ]
    }
  },
  "required": [
    "filename",
    "contentBase64"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_import_inspect",
  "arguments": {
    "filename": "example.xml",
    "contentBase64": "PHgvPg=="
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_inspect`

Inspect native ADL 2, OPT 2 ADL or OPT 1.4 XML paths, RM types, multiplicities and original terminology. Explicit format and validation profile; no guessed paths or clinical approval.

External dependency: configured native openEHR engine; no terminology server or CDR required.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2097152
    },
    "format": {
      "type": "string",
      "enum": [
        "adl2",
        "opt2",
        "opt14"
      ]
    },
    "dependencies": {
      "type": "array",
      "default": [],
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "identifier",
          "content"
        ],
        "properties": {
          "identifier": {
            "type": "string",
            "minLength": 2,
            "maxLength": 300
          },
          "content": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2097152
          }
        }
      },
      "maxItems": 64
    }
  },
  "required": [
    "content",
    "format"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_inspect",
  "arguments": {
    "content": "<ADL 2 source>",
    "format": "adl2"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_project_create`

Create a persistent modelling workspace. Requires deployment write enablement and authorized draft-write scope or role in OIDC mode.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "description": {
      "type": "string",
      "default": "",
      "maxLength": 10000
    }
  },
  "required": [
    "id",
    "name"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_project_create",
  "arguments": {
    "id": "neonatal-care",
    "name": "Neonatal care"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_project_get`

Open a project and list its logical artefacts and revision identifiers.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    }
  },
  "required": [
    "project"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_project_get",
  "arguments": {
    "project": "neonatal-care"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_project_qa`

Inspect an exact repository model revision, document profile, recorded provenance, requirement trail, authentic validation/review events, explicit terminology findings, and hash-verified saved native build evidence tied to that source. Missing semantic, terminology and clinical qualification checks remain unexecuted; no approval or model write occurs.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "path": {
      "type": "string"
    },
    "revision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "format": {
      "type": [
        "null",
        "string"
      ],
      "default": null,
      "enum": [
        "xml",
        "oet",
        "opt",
        "adl",
        "aql",
        "flat",
        "structured",
        null
      ]
    }
  },
  "required": [
    "project",
    "path"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_project_qa",
  "arguments": {
    "project": "neonatal-care",
    "path": "templates/admission.oet"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_projects`

List persistent projects and actual repository capabilities.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_projects",
  "arguments": {}
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_qa`

Run the modelling QA preflight. Missing validators and checks are NOT_EXECUTED; release eligibility stays false.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "string",
      "maxLength": 2097152
    },
    "format": {
      "type": "string",
      "enum": [
        "xml",
        "oet",
        "opt",
        "adl",
        "aql",
        "flat",
        "structured"
      ]
    }
  },
  "required": [
    "content",
    "format"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_qa",
  "arguments": {
    "content": "<a/>",
    "format": "xml"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_repository_branches`

List one page of hosted branches and reported protection status. Null protection means unknown.

External dependency: configured Git remote or hosting API for hosted repository operations.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "page": {
      "type": "integer",
      "default": 1,
      "minimum": 1,
      "maximum": 10000
    }
  },
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_repository_branches",
  "arguments": {
    "page": 1
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_repository_diff`

Compare two reachable immutable Git revisions without executing external diff commands.

External dependency: configured Git remote or hosting API for hosted repository operations.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "baseRevision": {
      "type": "string"
    },
    "headRevision": {
      "type": "string"
    }
  },
  "required": [
    "baseRevision",
    "headRevision"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_repository_diff",
  "arguments": {
    "baseRevision": "<reachable-base-sha>",
    "headRevision": "<reachable-head-sha>"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_repository_info`

Discover the configured repository's capabilities, active branch and optional hosted metadata.

External dependency: configured Git remote or hosting API for hosted repository operations.

Input schema:

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_repository_info",
  "arguments": {}
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_requirements_coverage`

Compute coverage from explicit requirement links and existing project artefacts; not clinical or test coverage.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "requirements": {
      "type": "array",
      "items": {
        "type": "object"
      },
      "maxItems": 1000
    },
    "links": {
      "type": "array",
      "items": {
        "type": "object"
      },
      "maxItems": 5000
    }
  },
  "required": [
    "project",
    "requirements",
    "links"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_requirements_coverage",
  "arguments": {
    "project": "neonatal-care",
    "requirements": [
      {
        "id": "REQ-1"
      }
    ],
    "links": []
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_review_get`

Read hosted review metadata. Hosting review state is separate from authenticated clinical approval.

External dependency: configured Git remote or hosting API for hosted repository operations.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "number": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "number"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_review_get",
  "arguments": {
    "number": 1
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_review_request`

Open a draft hosted review against the configured target or return an existing open review. Never approves a clinical model or merges. Requires write access.

External dependency: configured Git remote or hosting API for hosted repository operations.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "branch": {
      "type": "string",
      "maxLength": 200
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "body": {
      "type": "string",
      "default": "",
      "maxLength": 20000
    }
  },
  "required": [
    "branch",
    "title"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_review_request",
  "arguments": {
    "branch": "draft/admission",
    "title": "Review admission draft",
    "body": "Validation evidence and unresolved findings."
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_terminology_inspect`

Inspect explicit OET/OPT coded constraints and existing references without changing source bytes. Positional locations apply only to the recorded revision; inherited ADL semantics require the engine.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "path": {
      "type": "string"
    },
    "revision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "path"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_terminology_inspect",
  "arguments": {
    "project": "neonatal-care",
    "path": "templates/admission.oet"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_traceability_explain`

Answer why an element exists from the stored requirement and decision trail, including associated terminology, validation and review evidence. Node identifiers come from the persisted graph; no rationale is inferred.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "node": {
      "type": "string"
    },
    "revision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "node"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_traceability_explain",
  "arguments": {
    "project": "neonatal-care",
    "node": "C-1"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_traceability_get`

Read a versioned requirements graph, resolve pinned source/anchor/audit references and report declared coverage and unresolved/stale evidence. Native inherited openEHR paths require the qualified engine.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "revision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_traceability_get",
  "arguments": {
    "project": "neonatal-care"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_traceability_requirement`

Return the exact model elements explicitly linked to a requirement, with full/partial/excluded/unresolved declarations and reference verification. An authentic validation or review event does not certify every graph assertion.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "requirement": {
      "type": "string"
    },
    "revision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "requirement"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_traceability_requirement",
  "arguments": {
    "project": "neonatal-care",
    "requirement": "R-023"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_traceability_save`

Save the project's explicit requirement/decision/model/evidence graph as a conditional DRAFT revision. Graph schema and pinned references are checked; this does not prove clinical satisfaction or approve a model.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "graph": {
      "type": "object"
    },
    "expectedRevision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "graph"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_traceability_save",
  "arguments": {
    "project": "neonatal-care",
    "graph": {
      "schema": 1,
      "nodes": [
        {
          "id": "R-023",
          "type": "requirement",
          "title": "Project requirement",
          "description": "Record the actual user-supplied modelling requirement.",
          "provenance": [
            "Project requirements workshop notes"
          ],
          "priority": "must",
          "status": "ACTIVE"
        }
      ],
      "edges": []
    }
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `model_validate`

Run deterministic bounded preflight checks. Partial results never certify deployment.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "string",
      "maxLength": 2097152
    },
    "format": {
      "type": "string",
      "enum": [
        "xml",
        "oet",
        "opt",
        "adl",
        "aql",
        "flat",
        "structured"
      ]
    }
  },
  "required": [
    "content",
    "format"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "model_validate",
  "arguments": {
    "content": "<a/>",
    "format": "xml"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `opt_validate`

Validate OPT 2 ADL using native flat AOM/RM checks, or OPT 1.4 XML using its independent schema and explicit RM structure profile. Inspect checks and limitations: legacy profile is not full AOM semantic conformance or clinical approval.

External dependency: configured native openEHR engine; no terminology server or CDR required.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2097152
    }
  },
  "required": [
    "content"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "opt_validate",
  "arguments": {
    "content": "<OPT 2 ADL source>"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `template_build_oet`

Generate a draft OET from a retrieved COMPOSITION using either 1–30 direct ENTRY identifiers (`entries`) or up to 30 explicit parent-linked nested SECTION/ENTRY/CLUSTER/ELEMENT placements (`placements`). Each nested placement supplies a unique local `id`, a `parent` (`root` or an earlier placement id), an archetype `identifier`, and the exact parent-archetype-relative `path`; optional `min`, `max` and `name` values narrow that placement. The configured native engine compile-checks drafts against the exact ADL bytes fetched for this generation. Without the engine the report says `NOT_EXECUTED`. A passing bounded compiler profile is not complete legacy semantics or clinical approval.

External dependency: configured CKM REST API.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "composition": {
      "type": "string"
    },
    "entries": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 30,
      "uniqueItems": true
    },
    "placements": {
      "type": "array",
      "maxItems": 30,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "parent", "identifier", "path"],
        "properties": {
          "id": {"type": "string", "minLength": 1, "maxLength": 64},
          "parent": {"type": "string", "minLength": 1, "maxLength": 64},
          "identifier": {"type": "string", "minLength": 1, "maxLength": 300},
          "path": {"type": "string", "minLength": 2, "maxLength": 2048},
          "min": {"type": "string", "pattern": "^[0-9]+$"},
          "max": {"type": "string", "pattern": "^(?:[0-9]+|\\*)$"},
          "name": {"type": "string", "minLength": 1, "maxLength": 1000}
        }
      }
    },
    "ckm": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "name",
    "composition"
  ],
  "additionalProperties": false
}
```

Supply exactly one of `entries` or `placements`. Placements must be ordered parent-first, use compatible RM parent/child classes, and have unique paths per parent. The generator does not invent paths, slot constraints or terminology bindings.

Example `tools/call` parameters:

```json
{
  "name": "template_build_oet",
  "arguments": {
    "name": "Admission draft",
    "composition": "openEHR-EHR-COMPOSITION.encounter.v1",
    "entries": [
      "openEHR-EHR-OBSERVATION.body_weight.v2"
    ]
  }
}
```

Nested example:

```json
{
  "name": "Admission draft",
  "composition": "openEHR-EHR-COMPOSITION.encounter.v1",
  "placements": [
    {"id":"section","parent":"root","identifier":"openEHR-EHR-SECTION.admission.v1","path":"/content[at0001]"},
    {"id":"assessment","parent":"section","identifier":"openEHR-EHR-EVALUATION.assessment.v1","path":"/items[at0001]"},
    {"id":"details","parent":"assessment","identifier":"openEHR-EHR-CLUSTER.details.v1","path":"/data[at0001]/items[at0002]"}
  ]
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.

## `template_compile`

Compile ADL 2 into OPT 2 ADL, or supported OET XML plus exact ADL 1.4 dependencies into OPT 1.4 XML. Returns native output, hashes, dependency evidence and explicit validation profile. Legacy nested placements, bounded rules and original terms are preserved; unsupported constructs fail closed. No repository write, clinical approval or CDR deployment.

External dependency: configured native openEHR engine; no terminology server or CDR required.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2097152
    },
    "dependencies": {
      "type": "array",
      "default": [],
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "identifier",
          "content"
        ],
        "properties": {
          "identifier": {
            "type": "string",
            "minLength": 2,
            "maxLength": 300
          },
          "content": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2097152
          }
        }
      },
      "maxItems": 64
    }
  },
  "required": [
    "content"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "template_compile",
  "arguments": {
    "content": "<ADL 2 template>",
    "dependencies": [
      {
        "identifier": "<exact archetype identifier>",
        "content": "<ADL 2 dependency>"
      }
    ]
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `template_compile_project`

Compile an exact ADL 2 or supported OET template repository revision with explicit dependency revisions. Atomically save a native OPT 2 ADL or OPT 1.4 XML DRAFT, preserving source hashes, compiler profile, dependency revisions, limitations and validation evidence. Never overwrites a build or approves a clinical model.

External dependency: configured native openEHR engine; no terminology server or CDR required.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "path": {
      "type": "string"
    },
    "revision": {
      "type": "string",
      "minLength": 1
    },
    "dependencies": {
      "type": "array",
      "default": [],
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "identifier",
          "path",
          "revision"
        ],
        "properties": {
          "identifier": {
            "type": "string",
            "minLength": 2,
            "maxLength": 300
          },
          "path": {
            "type": "string",
            "minLength": 1,
            "maxLength": 240
          },
          "revision": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          }
        }
      },
      "maxItems": 64
    }
  },
  "required": [
    "project",
    "path",
    "revision"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "template_compile_project",
  "arguments": {
    "project": "modelling-demo",
    "path": "templates/fixture.adlt",
    "revision": "<exact template revision>",
    "dependencies": [
      {
        "identifier": "<exact archetype identifier>",
        "path": "archetypes/composition.adls",
        "revision": "<exact dependency revision>"
      }
    ]
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `template_validate`

Validate an ADL 2 template or compile-check the explicit legacy OET compatibility profile with exact supplied archetypes. OET requires ADL 1.4 dependencies and uses RM 1.0.2; unsupported constructs fail. Read profile, checks and limitations; legacy checks are not full AOM conformance.

External dependency: configured native openEHR engine; no terminology server or CDR required.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2097152
    },
    "dependencies": {
      "type": "array",
      "default": [],
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "identifier",
          "content"
        ],
        "properties": {
          "identifier": {
            "type": "string",
            "minLength": 2,
            "maxLength": 300
          },
          "content": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2097152
          }
        }
      },
      "maxItems": 64
    }
  },
  "required": [
    "content"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "template_validate",
  "arguments": {
    "content": "<ADL 2 template>",
    "dependencies": [
      {
        "identifier": "<exact archetype identifier>",
        "content": "<ADL 2 dependency>"
      }
    ]
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## `terminology_binding_plan`

Propose review candidates from exact project ValueSet membership. Preserve existing bindings and original constraints; aliases explicitly declare terminology_id, canonical system, optional version and archetype. No code is invented or applied.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "path": {
      "type": "string"
    },
    "revision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "aliases": {
      "type": "array",
      "default": [],
      "items": {
        "type": "object"
      },
      "maxItems": 100
    }
  },
  "required": [
    "project",
    "path"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_binding_plan",
  "arguments": {
    "project": "neonatal-care",
    "path": "templates/admission.oet"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_binding_plan_get`

Read a saved terminology plan and recompute freshness against current source and the whole project catalogue. Historical evidence never establishes current validation or clinical approval.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "path": {
      "type": "string"
    },
    "revision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "path"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_binding_plan_get",
  "arguments": {
    "project": "neonatal-care",
    "path": "templates/admission.oet"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_binding_plan_save`

Recompute and persist a DRAFT terminology plan against an explicit model revision. expectedRevision is required to replace an existing plan. This writes evidence only; it cannot alter or clinically approve the model.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "path": {
      "type": "string"
    },
    "modelRevision": {
      "type": "string"
    },
    "aliases": {
      "type": "array",
      "default": [],
      "items": {
        "type": "object"
      },
      "maxItems": 100
    },
    "expectedRevision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "path",
    "modelRevision"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_binding_plan_save",
  "arguments": {
    "project": "neonatal-care",
    "path": "templates/admission.oet",
    "modelRevision": "<observed-model-revision>",
    "aliases": []
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_binding_validate`

Validate an explicit platform terminology binding against a versioned value set and supplied OET/XML. Native binding application is not performed.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "binding": {
      "type": "object"
    },
    "valueSet": {
      "type": "object"
    },
    "model": {
      "type": "string",
      "maxLength": 2097152
    }
  },
  "required": [
    "binding",
    "valueSet",
    "model"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_binding_validate",
  "arguments": {
    "binding": {
      "id": "b",
      "artifact": "templates/admission.oet",
      "node": "/example",
      "strength": "REQUIRED",
      "value_set": "feeding",
      "value_set_version": "1",
      "codes": [
        "mixed"
      ]
    },
    "valueSet": {
      "id": "feeding",
      "system": "https://example.org/local/feeding",
      "version": "1",
      "source": "local",
      "concepts": [
        {
          "code": "mixed",
          "display": "Mixed feeding"
        }
      ]
    },
    "model": "<template><Rule path=\"/example\"/></template>"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_capabilities`

Read the configured FHIR provider's capability statement. Never assumes every operation exists.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_capabilities",
  "arguments": {}
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_catalogue_expand`

Expand explicit project value-set members with bounded paging; external references preserve provider version/coverage evidence.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "valueSet": {
      "type": "string"
    },
    "version": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "count": {
      "type": "integer",
      "default": 50,
      "minimum": 0,
      "maximum": 500
    },
    "offset": {
      "type": "integer",
      "default": 0,
      "minimum": 0,
      "maximum": 1000000
    },
    "language": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "filter": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "valueSet"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_catalogue_expand",
  "arguments": {
    "project": "neonatal-care",
    "valueSet": "https://example.org/sets/feeding",
    "version": "1"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_catalogue_get`

Read a project terminology resource by canonical and optional edition. Multiple editions require an explicit version; historical reads also require that version.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "kind": {
      "type": "string",
      "enum": [
        "code_system",
        "value_set",
        "concept_map"
      ]
    },
    "canonical": {
      "type": "string"
    },
    "version": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "revision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "kind",
    "canonical"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_catalogue_get",
  "arguments": {
    "project": "neonatal-care",
    "kind": "code_system",
    "canonical": "https://example.org/local/feeding",
    "version": "1"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_catalogue_lookup`

Look up a code in a versioned project CodeSystem. Local resources work offline; explicit external references use the optional configured provider.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "system": {
      "type": "string"
    },
    "code": {
      "type": "string"
    },
    "version": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "language": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "system",
    "code"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_catalogue_lookup",
  "arguments": {
    "project": "neonatal-care",
    "system": "https://example.org/local/feeding",
    "code": "mixed"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_catalogue_save`

Save a versioned DRAFT local CodeSystem, ValueSet, ConceptMap or external reference in the project repository. Provenance is required; expectedRevision is required when replacing a record. This does not approve clinical content.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "record": {
      "type": "object"
    },
    "expectedRevision": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "record"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_catalogue_save",
  "arguments": {
    "project": "neonatal-care",
    "record": {
      "kind": "code_system",
      "canonical": "https://example.org/local/feeding",
      "version": "1",
      "name": "Feeding",
      "provenance": {
        "source": "Organisation-authored local draft"
      },
      "concepts": [
        {
          "code": "mixed",
          "display": "Mixed feeding"
        }
      ]
    }
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_catalogue_search`

Deterministic project terminology search over names/descriptions and exact canonical identifiers. Invalid records remain explicit QA findings.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "kind": {
      "type": [
        "null",
        "string"
      ],
      "default": null,
      "enum": [
        "code_system",
        "value_set",
        "concept_map",
        null
      ]
    },
    "canonical": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "query": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "count": {
      "type": "integer",
      "default": 50,
      "minimum": 1,
      "maximum": 100
    },
    "offset": {
      "type": "integer",
      "default": 0,
      "minimum": 0,
      "maximum": 10000
    }
  },
  "required": [
    "project"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_catalogue_search",
  "arguments": {
    "project": "neonatal-care",
    "query": "feeding"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_catalogue_translate`

Read project ConceptMap candidates. Conditions, ambiguous targets and unconfirmed source editions remain explicit; no mapping is automatically applied.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "conceptMap": {
      "type": "string"
    },
    "system": {
      "type": "string"
    },
    "code": {
      "type": "string"
    },
    "version": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "codeSystemVersion": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "targetSystem": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "conceptMap",
    "system",
    "code"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_catalogue_translate",
  "arguments": {
    "project": "neonatal-care",
    "conceptMap": "https://example.org/maps/feeding",
    "system": "https://example.org/local/feeding",
    "code": "mixed"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_catalogue_validate`

Validate code-system or explicit value-set membership in the project catalogue, keeping resource and code-system editions separate. Draft checks do not confer clinical approval.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string"
    },
    "system": {
      "type": "string"
    },
    "code": {
      "type": "string"
    },
    "valueSet": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "version": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "codeSystemVersion": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "display": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "language": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "project",
    "system",
    "code"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_catalogue_validate",
  "arguments": {
    "project": "neonatal-care",
    "system": "https://example.org/local/feeding",
    "code": "mixed",
    "version": "1"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_diff`

Compare value-set concepts semantically; report changes without automatically replacing codes.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "before": {
      "type": "object"
    },
    "after": {
      "type": "object"
    }
  },
  "required": [
    "before",
    "after"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_diff",
  "arguments": {
    "before": {
      "id": "feeding",
      "system": "https://example.org/local/feeding",
      "version": "1",
      "source": "local",
      "concepts": [
        {
          "code": "mixed",
          "display": "Mixed feeding"
        }
      ]
    },
    "after": {
      "id": "feeding",
      "system": "https://example.org/local/feeding",
      "version": "2",
      "source": "local",
      "concepts": [
        {
          "code": "mixed",
          "display": "Mixed feeding"
        }
      ]
    }
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_expand`

Request a bounded value-set expansion. The server may return a partial page; never treat it as the whole value set.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "valueSet": {
      "type": "string"
    },
    "version": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "count": {
      "type": "integer",
      "default": 50,
      "minimum": 0,
      "maximum": 500
    },
    "offset": {
      "type": "integer",
      "default": 0,
      "minimum": 0,
      "maximum": 1000000
    },
    "language": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "filter": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "valueSet"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_expand",
  "arguments": {
    "valueSet": "http://snomed.info/sct?fhir_vs=isa/404684003",
    "count": 2
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_lookup`

Look up a code and display in the configured external terminology server.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "system": {
      "type": "string"
    },
    "code": {
      "type": "string"
    },
    "version": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "language": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "system",
    "code"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_lookup",
  "arguments": {
    "system": "http://snomed.info/sct",
    "code": "404684003"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_manifest`

Produce declared terminology dependencies for a template from explicit binding records.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "artifact": {
      "type": "string"
    },
    "bindings": {
      "type": "array",
      "items": {
        "type": "object"
      },
      "maxItems": 1000
    }
  },
  "required": [
    "artifact",
    "bindings"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_manifest",
  "arguments": {
    "artifact": "templates/admission.oet",
    "bindings": []
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_resolve`

Resolve an openEHR Terminology concept ID to its rubric, or find the concept ID for a given rubric.

Use this tool to match openEHR Terminology identifiers (concept IDs) to human-readable labels (rubrics) and vice versa.
It searches across all groups defined in the openEHR Terminology.
Matching:
- If `input` is numeric, it's treated as a concept (ID), and the corresponding rubric is returned.
- If `input` is non-numeric, it's treated as a rubric (case-insensitive) and the corresponding ID is returned.
- An optional `groupId` can be provided to restrict the search to a specific openEHR Terminology group.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "input": {
      "type": "string",
      "description": "The concept ID (e.g., \"433\") or concept rubric (e.g., \"event\") to resolve."
    },
    "groupId": {
      "type": "string",
      "description": "Optional openEHR terminology group ID (e.g., \"composition_category\") to restrict the search.",
      "default": ""
    }
  },
  "required": [
    "input"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_resolve",
  "arguments": {
    "input": "433"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "rubric",
    "groupId",
    "groupName"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "rubric": {
      "type": "string"
    },
    "groupId": {
      "type": "string"
    },
    "groupName": {
      "type": "string"
    }
  }
}
```

## `terminology_resource_get`

Retrieve a uniquely resolved canonical and optional version. Never silently choose between multiple editions.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "resourceType": {
      "type": "string",
      "enum": [
        "CodeSystem",
        "ValueSet",
        "ConceptMap"
      ]
    },
    "canonical": {
      "type": "string"
    },
    "version": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "resourceType",
    "canonical"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_resource_get",
  "arguments": {
    "resourceType": "ValueSet",
    "canonical": "https://example.org/ValueSet/feeding",
    "version": "1"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_resource_search`

Discover CodeSystem, ValueSet or ConceptMap resources on the configured server. A bounded page may be incomplete.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "resourceType": {
      "type": "string",
      "enum": [
        "CodeSystem",
        "ValueSet",
        "ConceptMap"
      ]
    },
    "canonical": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "version": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "name": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "count": {
      "type": "integer",
      "default": 50,
      "minimum": 1,
      "maximum": 100
    }
  },
  "required": [
    "resourceType"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_resource_search",
  "arguments": {
    "resourceType": "ValueSet",
    "name": "feeding",
    "count": 10
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_translate`

Translate using an explicit ConceptMap. All candidate mappings require human review; no binding is changed.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "conceptMap": {
      "type": "string"
    },
    "system": {
      "type": "string"
    },
    "code": {
      "type": "string"
    },
    "version": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "codeSystemVersion": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "sourceValueSet": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "targetValueSet": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "targetSystem": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "conceptMap",
    "system",
    "code"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_translate",
  "arguments": {
    "conceptMap": "https://example.org/ConceptMap/example",
    "system": "https://example.org/CodeSystem/source",
    "code": "example",
    "version": "1"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `terminology_validate_code`

Verify a code against a code system or value set; unavailable validation returns NOT_EXECUTED.

version identifies the ValueSet when valueSet is set, otherwise the CodeSystem.

External dependency: configured FHIR terminology provider when an external source is selected.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "system": {
      "type": "string"
    },
    "code": {
      "type": "string"
    },
    "valueSet": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "version": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "codeSystemVersion": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "display": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    "language": {
      "type": [
        "null",
        "string"
      ],
      "default": null
    }
  },
  "required": [
    "system",
    "code"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "terminology_validate_code",
  "arguments": {
    "system": "http://snomed.info/sct",
    "code": "404684003"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "success",
    "result",
    "error"
  ],
  "properties": {
    "success": {
      "type": "boolean"
    },
    "result": {
      "type": [
        "object",
        "null"
      ]
    },
    "error": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
}
```

Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.

## `type_specification_get`

Retrieve the full specification of a specific openEHR Type (class) as BMM JSON, including attributes, semantic constraints and documentation.

Use this tool when you need to retrieve the full, machine-readable BMM definition for a type so an LLM can:
- inspect properties/attributes and their declared types,
- understand inheritance (super-types/sub-types),
- or generate client code / mappings based on the canonical model definition.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "The openEHR Type name (e.g. `DV_QUANTITY`, `COMPOSITION`, etc.)"
    },
    "component": {
      "type": [
        "null",
        "string"
      ],
      "description": "Optional openEHR Component name, for better matching or filtering; if omitted, the first matching openEHR Type specification is returned.",
      "default": null,
      "enum": [
        "AM",
        "AM2",
        "BASE",
        "LANG",
        "RM",
        "TERM",
        null
      ]
    }
  },
  "required": [
    "name"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "type_specification_get",
  "arguments": {
    "name": "DV_TEXT",
    "component": "RM"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": true,
  "required": [
    "name",
    "resourceUri"
  ],
  "properties": {
    "name": {
      "type": "string",
      "description": "openEHR Type name (e.g. `DV_QUANTITY`)"
    },
    "documentation": {
      "type": "string",
      "description": "Documentation or description of the type"
    },
    "is_abstract": {
      "type": "boolean",
      "description": "Whether the type is abstract (i.e. cannot be instantiated)"
    },
    "ancestors": {
      "type": "array",
      "description": "List of ancestor types (super-types)"
    },
    "resourceUri": {
      "type": "string",
      "format": "uri",
      "description": "URI of corresponding resource in the `openehr://spec/type` namespace"
    },
    "constants": {
      "type": "object",
      "description": "List of constants/enum values"
    },
    "properties": {
      "type": "object",
      "description": "List of attributes/properties"
    },
    "functions": {
      "type": "object",
      "description": "List of functions"
    },
    "invariants": {
      "type": "object",
      "description": "List of semantic constraints"
    },
    "package": {
      "type": "string",
      "description": "Package name (e.g. `org.openehr.rm.datatypes`)"
    },
    "specUrl": {
      "type": "string",
      "description": "Link to the corresponding openEHR specification page and fragment with more narrative details"
    }
  }
}
```

## `type_specification_search`

Search for and discover openEHR Type specifications by name pattern with an optional keyword filter to locate canonical definitions and resource URIs.

This tool is designed for LLM workflows that need to:
- discover the canonical definition of an openEHR Type (class),
- locate the exact type specification URL or server resource URI,
- or fetch the full definition via the `type_specification_get` tool.

External dependency: none.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "namePattern": {
      "type": "string",
      "description": "A type-name pattern. Matching behaviour: minimal 3 chars, supports a simple `*` wildcard (glob-like). Examples:`ARCHETYPE_SLOT` (exact), `ARCHETYPE_SL*` (wildcard prefix), `DV_*` (family search)."
    },
    "keyword": {
      "type": "string",
      "description": "Optional raw substring filter applied to the JSON content (not normalized; case-insensitive); use this when you want to narrow results to Types containing a concept or attribute name.",
      "default": ""
    }
  },
  "required": [
    "namePattern"
  ],
  "additionalProperties": false
}
```

Example `tools/call` parameters:

```json
{
  "name": "type_specification_search",
  "arguments": {
    "namePattern": "DV_TEXT"
  }
}
```

Output schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "items",
    "total"
  ],
  "properties": {
    "items": {
      "type": "array",
      "description": "List of matching openEHR Type specifications",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "name",
          "documentation",
          "resourceUri",
          "component",
          "package",
          "specUrl"
        ],
        "properties": {
          "name": {
            "type": "string",
            "description": "openEHR Type name (e.g. `DV_QUANTITY`)"
          },
          "documentation": {
            "type": "string",
            "description": "Documentation or description of the type"
          },
          "resourceUri": {
            "type": "string",
            "format": "uri",
            "description": "URI of corresponding resource in the `openehr://spec/type` namespace"
          },
          "component": {
            "type": "string",
            "description": "openEHR Component name (e.g. `AM`, `RM`, etc.)"
          },
          "package": {
            "type": "string",
            "description": "Package name (e.g. `org.openehr.rm.datatypes`)"
          },
          "specUrl": {
            "type": "string",
            "description": "Link to the corresponding openEHR specification page and fragment with more narrative details"
          }
        }
      }
    },
    "total": {
      "type": "integer",
      "minimum": 0,
      "description": "Number of matching types. Unlike the other search tools, this one neither caps nor paginates, so `total` always equals items.length."
    }
  }
}
```
