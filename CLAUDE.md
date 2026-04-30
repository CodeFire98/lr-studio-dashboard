# Project rules for Claude Code

## Always read REFERENCE.md first

`REFERENCE.md` (in this same directory) is the single source of truth for
this codebase: glossary, architecture, data model, routes, deployment,
external services, decision log. Read it before touching anything in this
repo so you have correct context.

## Always update REFERENCE.md when you make material changes

If your change adds/removes/renames anything in:
- the glossary or nomenclature
- the data model (tables, columns, RLS policies, triggers, RPCs)
- routes / views or their behaviour
- key feature flows
- edge functions or external integrations
- deployment or secret-storage locations
- the known-decisions log (new "we tried X, chose Y" moments)

…then update the relevant section of `REFERENCE.md` **in the same change**,
bump the `Last updated` field, and add a one-line entry to the
**Recent changes log** at the top of the doc.

Out-of-date docs are worse than no docs. If you're unsure whether a change
is "material," err on the side of updating.
