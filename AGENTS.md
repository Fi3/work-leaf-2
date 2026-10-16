Use only README for documenting things, use ASD-STE100 communication standard for both documentation
and your answears. Do not make up words, if yuo need to do it make sure to define them before. Use a
modularized logic with good abstractions (hide complexity under high level reusable abstractions)
always. Do not reimplement things if they are already available. Try to keep functions small (modules
are internally complex, module interfaces are simple, functions are simple when possible)

Put new things that will be need by every new agent in this file, not everything keep it as short as
possible. (tooling, how to execute things, any file that should never be changed ecc ecc)

Always reuse the stile and the conventions used by the files that you are changing.

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
- Use Rust for the server and command client. Small JavaScript Pi and Lua Neovim adapters are authorized.
- The mandatory Pi dependency tree is permitted after audit. Follow the strict application dependency rules in `SPEC.md`.

## Test
test must not mirror the implementation. use prop test when possible.

## Implementation checks

- Shared protocol fixtures are in `tests/fixtures/protocol.json`.
- Run `sh scripts/check.sh` for the complete local release gate.
- Use the exact runtimes and locked installation in README.md. Terminal tests use Python 3 standard-library tools only.
- Keep dependency changes subject to `scripts/check-dependencies.sh` and review its recorded baseline.
