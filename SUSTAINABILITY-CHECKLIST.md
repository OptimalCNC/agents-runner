# Post-Task Checklist

Read this file **after** your main task is complete. Walk through every section below and think honestly. If any item reveals a gap, fix it before finishing.

## What Else Did I Touch?

Changes rarely live in isolation. Think about the blast radius:

- [ ] Did I change a boundary that other components depend on — a shared type, an API shape, an event format, a store schema? If so, did I update every consumer on both sides (backend and frontend)?
- [ ] Did I change behavior that another module assumes is stable? Trace the callers and imports — not just the direct ones, but anything downstream that might silently break.
- [ ] Did I introduce a new concept, convention, or pattern? If a future agent encounters it without context, will they understand it or will they fight against it?

## Will a Future Agent Understand This?

This is the most important section. Development documents are how future agents (and developers) learn to work in this codebase. If the docs are wrong or incomplete, future work will go in the wrong direction.

For each question, mentally scan the docs in the project — don't skip this step:

- [ ] **Architecture** — Did I change how the system is structured, how components communicate, or how data flows? If so, the relevant architecture docs must reflect that, or a future agent will build on a false mental model.
- [ ] **Interfaces & contracts** — Did I change a public interface, a workflow definition, a module boundary, or an extension point? If so, any guide that teaches how to extend or integrate with that interface must be updated.
- [ ] **Setup & commands** — Did I add a dependency, a new dev command, a new environment variable, or change how the project is built or run? If so, the development guide must stay accurate.
- [ ] **Features & capabilities** — Did I add, remove, or change a user-facing feature or a workflow mode? If so, the product-level docs must describe the current state, not the old one.
- [ ] **Conventions & patterns** — Did I establish a new pattern (e.g., a new way to handle errors, a new file-naming scheme, a new test strategy)? If it's important enough that future agents should follow it, it needs to be documented somewhere they'll find it.
