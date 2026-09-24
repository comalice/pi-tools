# Language Server Direction

Status: deferred. Keep this note as a design checkpoint before expanding
`inspect_ast` beyond its current JavaScript/TypeScript outline and implementation
operations.

## Why Revisit It

Dirac's AST service uses Tree-sitter grammars and queries for many languages.
The Pi port currently uses `ts-morph`, which is a practical narrow prototype but
does not provide language-server semantics. Language servers can resolve symbols
using the actual project configuration and offer document symbols, definitions,
references, and rename operations.

## Possible Design

- Use `textDocument/documentSymbol` for hierarchical outlines and declaration
  ranges; read the corresponding document ranges for complete implementations.
- Use workspace symbol and reference requests for cross-file symbol lookup,
  subject to each server's supported capabilities.
- Keep `inspect_ast` independent of the server implementation behind a small
  backend interface. Treat Tree-sitter or `ts-morph` as an optional fallback,
  not as an assumed semantic equivalent.
- Start only configured, locally installed servers. Do not download or install
  language servers implicitly.
- Scope server processes to a Pi workspace and handle initialization, timeouts,
  cancellation, shutdown, and unsupported capabilities explicitly.

## Caveats

Language-server availability and behavior vary by language and project setup.
Some servers require project dependencies or indexing, and symbol ranges or
workspace search results are not fully consistent across implementations. Test
closed-on-disk files, unsaved changes, nested workspaces, and unavailable
servers before replacing the current backend.

No LSP transport or server lifecycle code is implemented yet.
