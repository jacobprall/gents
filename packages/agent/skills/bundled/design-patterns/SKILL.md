---
name: design-patterns
description: >-
  Identify and recommend GoF design patterns. Use when the user asks about
  design patterns, mentions a specific pattern by name (factory, singleton,
  observer, strategy, etc.), asks "which pattern should I use", wants to
  refactor code using patterns, or discusses object creation, structural
  composition, or behavioral delegation problems.
---
# Design Patterns

## What is a Design Pattern?

A design pattern is a general, reusable solution to a commonly occurring problem in software design. It is not a specific piece of code but a template for how to solve a problem that can be adapted to many situations.

A pattern is not an algorithm. An algorithm defines clear steps to achieve a goal. A pattern is a higher-level description of a solution — the same pattern applied to two programs may produce different code.

Each pattern consists of:
- **Intent** — the problem and the solution, briefly.
- **Motivation** — why the problem exists and how the pattern resolves it.
- **Structure** — the participants and their relationships.
- **Applicability** — when to use it (and when not to).

## Pattern Catalog

When the user asks about a pattern, read the corresponding file for full details (intent, problem, solution, structure, applicability, implementation steps, pros/cons, and relations with other patterns).

### Creational Patterns

Object creation mechanisms that increase flexibility and reuse.

| Pattern | Intent | File |
|---|---|---|
| Factory Method | Defer object creation to subclasses via a factory method | [creational/factory-method.md](creational/factory-method.md) |
| Abstract Factory | Produce families of related objects without specifying concrete classes | [creational/abstract-factory.md](creational/abstract-factory.md) |
| Builder | Construct complex objects step by step | [creational/builder.md](creational/builder.md) |
| Prototype | Copy existing objects without coupling to their classes | [creational/prototype.md](creational/prototype.md) |
| Singleton | Ensure a class has exactly one instance with a global access point | [creational/singleton.md](creational/singleton.md) |

### Structural Patterns

Assemble objects and classes into larger structures while keeping them flexible.

| Pattern | Intent | File |
|---|---|---|
| Adapter | Make incompatible interfaces work together | [structural/adapter.md](structural/adapter.md) |
| Bridge | Split abstraction from implementation so both can vary independently | [structural/bridge.md](structural/bridge.md) |
| Composite | Compose objects into trees; treat individual and composite objects uniformly | [structural/composite.md](structural/composite.md) |
| Decorator | Attach new behaviors to objects via wrapper objects | [structural/decorator.md](structural/decorator.md) |
| Facade | Provide a simplified interface to a complex subsystem | [structural/facade.md](structural/facade.md) |
| Flyweight | Share common state between many objects to save RAM | [structural/flyweight.md](structural/flyweight.md) |
| Proxy | Provide a substitute that controls access to another object | [structural/proxy.md](structural/proxy.md) |

### Behavioral Patterns

Algorithms and assignment of responsibilities between objects.

| Pattern | Intent | File |
|---|---|---|
| Chain of Responsibility | Pass requests along a chain of handlers | [behavioral/chain-of-responsibility.md](behavioral/chain-of-responsibility.md) |
| Command | Encapsulate a request as an object (supports undo, queuing, logging) | [behavioral/command.md](behavioral/command.md) |
| Iterator | Traverse a collection without exposing its internals | [behavioral/iterator.md](behavioral/iterator.md) |
| Mediator | Centralize complex communication between objects | [behavioral/mediator.md](behavioral/mediator.md) |
| Memento | Capture and restore object state without breaking encapsulation | [behavioral/memento.md](behavioral/memento.md) |
| Observer | Notify dependents automatically when state changes | [behavioral/observer.md](behavioral/observer.md) |
| State | Change behavior when internal state changes (appears to change class) | [behavioral/state.md](behavioral/state.md) |
| Strategy | Define interchangeable algorithms behind a common interface | [behavioral/strategy.md](behavioral/strategy.md) |
| Template Method | Define algorithm skeleton in superclass; let subclasses override steps | [behavioral/template-method.md](behavioral/template-method.md) |
| Visitor | Separate algorithms from the objects they operate on | [behavioral/visitor.md](behavioral/visitor.md) |

## How to Use This Skill

1. **User names a pattern** → Read the corresponding file. Explain the pattern with its intent, when to use it, pros/cons, and how it relates to alternatives.
2. **User describes a problem** → Match it to one or more patterns from the catalog above. Read those files. Recommend the best fit with rationale.
3. **User asks to compare patterns** → Read both files. Explain the differences using the "Relations with Other Patterns" section from each.
4. **User wants to apply a pattern** → Read the file's "How to Implement" section. Help them apply it to their specific code.

## Quick Pattern Selector

Common problem → pattern mapping:

| Problem | Consider |
|---|---|
| Need to create objects without specifying exact class | Factory Method, Abstract Factory |
| Complex object with many optional parts | Builder |
| Need exact copies of objects | Prototype |
| Only one instance allowed | Singleton |
| Incompatible interfaces need to work together | Adapter |
| Class hierarchy exploding in two dimensions | Bridge |
| Tree structures with uniform treatment | Composite |
| Add behavior without modifying class | Decorator |
| Simplify a complex subsystem API | Facade |
| Too many similar objects eating RAM | Flyweight |
| Control access / lazy-load / cache an object | Proxy |
| Multiple handlers, unknown which will process | Chain of Responsibility |
| Decouple sender from receiver, support undo | Command |
| Traverse collection without exposing internals | Iterator |
| Many-to-many dependencies between components | Mediator |
| Need undo via state snapshots | Memento |
| Notify subscribers of state changes | Observer |
| Object behavior changes with state | State |
| Swap algorithms at runtime | Strategy |
| Same algorithm structure, different step implementations | Template Method |
| Add operations to class hierarchy without modifying it | Visitor |

*Content sourced from [refactoring.guru](https://refactoring.guru/design-patterns)*
