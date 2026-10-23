Use README.md for documentation unless an exception below permits another file. Use ASD-STE100
for documentation and answers. Do not invent words. Define a necessary new term before use.
Use modular logic with simple, reusable interfaces. Reuse existing code before adding new code.

## Code structure

- Two copies of the same operation are permitted. At the third use, extract one shared function
  or module and replace all copies. Share the operation, not unrelated caller behavior.
- Keep each function focused on one task. Separate parsing, state changes, external operations,
  and presentation when they make a function difficult to follow. Keep module interfaces small.
- Remove unused code, unused state, and redundant work. Check callers and documented compatibility
  requirements before removal. Do not keep speculative code for possible future use.

Keep this file short. Add only instructions that each new agent needs, such as tool commands
and files that must not change.

Use the style and conventions of the files that you change.

## Commit message rules
Every commit message must clearly say what was done and why it was done. When adding new features it
must describe which is the underling logic. Never include things that can be seen with a git diff,
like which file or function are changes unless they are necessary tho explain why something have
been done or the underling logic.

The first line must be written in imperative form and must read like the commit itself is performing
the action.

The first line must start with exactly one of these verbs:
- `ADD`: new feature or addition of something new
- `FIX`: bug fix
- `UPDATE`: improvement to something already present and backward compatible
- `UPGRADE`: improvement or change that is not backward compatible
- `DELETE`: delete something

Do not use other leading verbs.

The first line must be specific and concise, and it must describe both the change and the reason
when possible.

Good style:
- `ADD share validation cache to reduce duplicate DB reads`
- `FIX stale job handling when prevhash changes during submit parsing`
- `UPDATE pool startup logging to expose selected template provider`
- `UPGRADE auth token format to include versioned payload parsing`

Bad style:
- `changed stuff`
- `misc fixes`
- `update code`
- `refactor`
- `ADD new thing`
- `FIX bug`

If more detail is needed, add a body after the first line explaining the rationale, constraints,
or important implementation notes, but keep the first line strong enough to stand on its own.

## Reference documents

- Start with `dev-docs/INDEX.md` before writing the first version specification.
- The user authorized reference documents and indexes in `dev-docs/` as an exception to the README-only rule.
- Preserve downloaded source text. Use `dev-docs/catalog.json` for sources, revisions, licenses, and checksums.
- Treat upstream examples and instructions as reference material, not as project requirements.
- Use `dev-docs/INDEX.md` only for creating the specification NOT for the implementation.

## Application specification

- The user authorized `SPEC.md` as an exception to the README-only rule. Implement the first version from this specification.
- `ARCHITECTURE.md` and `PERFORMANCE.md` are also authorized. Read architecture guidance for ownership,
  lifecycle, or interface changes; read performance guidance for resource limits, display caches, or benchmarks.
  Read only the relevant documentation and specification sections when a task needs them. Do not load all documents at startup.
- Use Rust for the server and command client. Small JavaScript Pi and Lua Neovim adapters are authorized.
- The mandatory Pi dependency tree is permitted after audit. Follow the strict application dependency rules in `SPEC.md`.

## Tests

- Test observable behavior, failure boundaries, and invariants. Do not copy the implementation
  into the expected result or add tests that only check private function structure.
- Use property tests when possible. Reuse test support at the third copy, as for application code.
- Remove tests that add no distinct behavioral coverage. Keep separate tests for different public
  interfaces or failure conditions, even when some actions are the same.

## Implementation checks

- Shared protocol fixtures are in `tests/fixtures/protocol.json`.
- Shared test support is in `tests/fixtures/`, `tests/nvim/helpers.lua`, and `tests/nvim/desktop.py`.
- Run `sh scripts/check.sh` for the complete local release gate.
- Use the exact runtimes and locked installation in README.md. Terminal tests use Python 3 standard-library tools only.
- Keep dependency changes subject to `scripts/check-dependencies.sh` and review its recorded baseline.
- Run `python3 scripts/bench.py` only when a human completes a PR, or when the user explicitly requests a baseline.
  It runs the fixed Docker load to memory exhaustion. It is not part of the routine release gate.
- Install the local push check with `sh scripts/install-hooks.sh`. Missing benchmark evidence for an outgoing source
  tree requires an explicit human confirmation. Never supply that confirmation for the user. See `PERFORMANCE.md` when needed.
