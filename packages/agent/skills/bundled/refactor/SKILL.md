---
name: refactoring
description: >-
  Identify code smells and apply refactoring techniques to improve code quality.
  Use when reviewing code for smells, planning refactors, cleaning up technical
  debt, or when the user mentions refactoring, code smells, clean code, or
  technical debt.
---

# Refactoring

Systematic process of improving code without creating new functionality that can transform a mess into clean code and simple design.

## When to Refactor

**Rule of Three**: (1) First time, just get it done. (2) Second time, cringe but repeat. (3) Third time, refactor.

- **Adding a feature** — refactor first to understand dirty code; clean code is easier to extend.
- **Fixing a bug** — bugs hide in the dirtiest code; cleaning reveals them.
- **Code review** — last chance to tidy before code goes public. Pair with the author.

## How to Refactor

Small changes, each leaving the program working. Never mix refactoring with new features — separate them at least by commit.

**Checklist**:
1. Code should become cleaner. If not, you mixed too many changes or the code needs a rewrite (write tests first).
2. No new functionality during refactoring.
3. All existing tests must pass. If tests break: (a) you introduced an error — fix it, or (b) tests were too low-level (testing privates) — refactor the tests or write higher-level BDD-style tests.

---

## Code Smells Index

Identify these patterns in code. Each file has: signs/symptoms, causes, treatment, payoff.

| # | Smell | Category | File |
|---|-------|----------|------|
| 1 | Long Method | Bloaters | [smells/bloaters/long-method.md](smells/bloaters/long-method.md) |
| 2 | Large Class | Bloaters | [smells/bloaters/large-class.md](smells/bloaters/large-class.md) |
| 3 | Primitive Obsession | Bloaters | [smells/bloaters/primitive-obsession.md](smells/bloaters/primitive-obsession.md) |
| 4 | Long Parameter List | Bloaters | [smells/bloaters/long-parameter-list.md](smells/bloaters/long-parameter-list.md) |
| 5 | Data Clumps | Bloaters | [smells/bloaters/data-clumps.md](smells/bloaters/data-clumps.md) |
| 6 | Alternative Classes with Different Interfaces | OO Abusers | [smells/oo-abusers/alternative-classes-with-different-interfaces.md](smells/oo-abusers/alternative-classes-with-different-interfaces.md) |
| 7 | Refused Bequest | OO Abusers | [smells/oo-abusers/refused-bequest.md](smells/oo-abusers/refused-bequest.md) |
| 8 | Switch Statements | OO Abusers | [smells/oo-abusers/switch-statements.md](smells/oo-abusers/switch-statements.md) |
| 9 | Temporary Field | OO Abusers | [smells/oo-abusers/temporary-field.md](smells/oo-abusers/temporary-field.md) |
| 10 | Divergent Change | Change Preventers | [smells/change-preventers/divergent-change.md](smells/change-preventers/divergent-change.md) |
| 11 | Shotgun Surgery | Change Preventers | [smells/change-preventers/shotgun-surgery.md](smells/change-preventers/shotgun-surgery.md) |
| 12 | Parallel Inheritance Hierarchies | Change Preventers | [smells/change-preventers/parallel-inheritance-hierarchies.md](smells/change-preventers/parallel-inheritance-hierarchies.md) |
| 13 | Comments | Dispensables | [smells/dispensables/comments.md](smells/dispensables/comments.md) |
| 14 | Duplicate Code | Dispensables | [smells/dispensables/duplicate-code.md](smells/dispensables/duplicate-code.md) |
| 15 | Data Class | Dispensables | [smells/dispensables/data-class.md](smells/dispensables/data-class.md) |
| 16 | Dead Code | Dispensables | [smells/dispensables/dead-code.md](smells/dispensables/dead-code.md) |
| 17 | Lazy Class | Dispensables | [smells/dispensables/lazy-class.md](smells/dispensables/lazy-class.md) |
| 18 | Speculative Generality | Dispensables | [smells/dispensables/speculative-generality.md](smells/dispensables/speculative-generality.md) |
| 19 | Feature Envy | Couplers | [smells/couplers/feature-envy.md](smells/couplers/feature-envy.md) |
| 20 | Inappropriate Intimacy | Couplers | [smells/couplers/inappropriate-intimacy.md](smells/couplers/inappropriate-intimacy.md) |
| 21 | Incomplete Library Class | Couplers | [smells/couplers/incomplete-library-class.md](smells/couplers/incomplete-library-class.md) |
| 22 | Message Chains | Couplers | [smells/couplers/message-chains.md](smells/couplers/message-chains.md) |
| 23 | Middle Man | Couplers | [smells/couplers/middle-man.md](smells/couplers/middle-man.md) |

---

## Refactoring Techniques Index

Apply these to fix identified smells. Each file has: problem, solution, how-to steps, benefits, drawbacks.

| # | Technique | Category | File |
|---|-----------|----------|------|
| 1 | Extract Method | Composing Methods | [techniques/composing-methods/extract-method.md](techniques/composing-methods/extract-method.md) |
| 2 | Inline Method | Composing Methods | [techniques/composing-methods/inline-method.md](techniques/composing-methods/inline-method.md) |
| 3 | Extract Variable | Composing Methods | [techniques/composing-methods/extract-variable.md](techniques/composing-methods/extract-variable.md) |
| 4 | Inline Temp | Composing Methods | [techniques/composing-methods/inline-temp.md](techniques/composing-methods/inline-temp.md) |
| 5 | Replace Temp with Query | Composing Methods | [techniques/composing-methods/replace-temp-with-query.md](techniques/composing-methods/replace-temp-with-query.md) |
| 6 | Split Temporary Variable | Composing Methods | [techniques/composing-methods/split-temporary-variable.md](techniques/composing-methods/split-temporary-variable.md) |
| 7 | Remove Assignments to Parameters | Composing Methods | [techniques/composing-methods/remove-assignments-to-parameters.md](techniques/composing-methods/remove-assignments-to-parameters.md) |
| 8 | Replace Method with Method Object | Composing Methods | [techniques/composing-methods/replace-method-with-method-object.md](techniques/composing-methods/replace-method-with-method-object.md) |
| 9 | Substitute Algorithm | Composing Methods | [techniques/composing-methods/substitute-algorithm.md](techniques/composing-methods/substitute-algorithm.md) |
| 10 | Move Method | Moving Features | [techniques/moving-features/move-method.md](techniques/moving-features/move-method.md) |
| 11 | Move Field | Moving Features | [techniques/moving-features/move-field.md](techniques/moving-features/move-field.md) |
| 12 | Extract Class | Moving Features | [techniques/moving-features/extract-class.md](techniques/moving-features/extract-class.md) |
| 13 | Inline Class | Moving Features | [techniques/moving-features/inline-class.md](techniques/moving-features/inline-class.md) |
| 14 | Hide Delegate | Moving Features | [techniques/moving-features/hide-delegate.md](techniques/moving-features/hide-delegate.md) |
| 15 | Remove Middle Man | Moving Features | [techniques/moving-features/remove-middle-man.md](techniques/moving-features/remove-middle-man.md) |
| 16 | Introduce Foreign Method | Moving Features | [techniques/moving-features/introduce-foreign-method.md](techniques/moving-features/introduce-foreign-method.md) |
| 17 | Introduce Local Extension | Moving Features | [techniques/moving-features/introduce-local-extension.md](techniques/moving-features/introduce-local-extension.md) |
| 18 | Self Encapsulate Field | Organizing Data | [techniques/organizing-data/self-encapsulate-field.md](techniques/organizing-data/self-encapsulate-field.md) |
| 19 | Replace Data Value with Object | Organizing Data | [techniques/organizing-data/replace-data-value-with-object.md](techniques/organizing-data/replace-data-value-with-object.md) |
| 20 | Change Value to Reference | Organizing Data | [techniques/organizing-data/change-value-to-reference.md](techniques/organizing-data/change-value-to-reference.md) |
| 21 | Change Reference to Value | Organizing Data | [techniques/organizing-data/change-reference-to-value.md](techniques/organizing-data/change-reference-to-value.md) |
| 22 | Replace Array with Object | Organizing Data | [techniques/organizing-data/replace-array-with-object.md](techniques/organizing-data/replace-array-with-object.md) |
| 23 | Duplicate Observed Data | Organizing Data | [techniques/organizing-data/duplicate-observed-data.md](techniques/organizing-data/duplicate-observed-data.md) |
| 24 | Change Unidirectional Association to Bidirectional | Organizing Data | [techniques/organizing-data/change-unidirectional-association-to-bidirectional.md](techniques/organizing-data/change-unidirectional-association-to-bidirectional.md) |
| 25 | Change Bidirectional Association to Unidirectional | Organizing Data | [techniques/organizing-data/change-bidirectional-association-to-unidirectional.md](techniques/organizing-data/change-bidirectional-association-to-unidirectional.md) |
| 26 | Encapsulate Field | Organizing Data | [techniques/organizing-data/encapsulate-field.md](techniques/organizing-data/encapsulate-field.md) |
| 27 | Encapsulate Collection | Organizing Data | [techniques/organizing-data/encapsulate-collection.md](techniques/organizing-data/encapsulate-collection.md) |
| 28 | Replace Magic Number with Symbolic Constant | Organizing Data | [techniques/organizing-data/replace-magic-number-with-symbolic-constant.md](techniques/organizing-data/replace-magic-number-with-symbolic-constant.md) |
| 29 | Replace Type Code with Class | Organizing Data | [techniques/organizing-data/replace-type-code-with-class.md](techniques/organizing-data/replace-type-code-with-class.md) |
| 30 | Replace Type Code with Subclasses | Organizing Data | [techniques/organizing-data/replace-type-code-with-subclasses.md](techniques/organizing-data/replace-type-code-with-subclasses.md) |
| 31 | Replace Type Code with State/Strategy | Organizing Data | [techniques/organizing-data/replace-type-code-with-state-strategy.md](techniques/organizing-data/replace-type-code-with-state-strategy.md) |
| 32 | Replace Subclass with Fields | Organizing Data | [techniques/organizing-data/replace-subclass-with-fields.md](techniques/organizing-data/replace-subclass-with-fields.md) |
| 33 | Decompose Conditional | Simplifying Conditionals | [techniques/simplifying-conditionals/decompose-conditional.md](techniques/simplifying-conditionals/decompose-conditional.md) |
| 34 | Consolidate Conditional Expression | Simplifying Conditionals | [techniques/simplifying-conditionals/consolidate-conditional-expression.md](techniques/simplifying-conditionals/consolidate-conditional-expression.md) |
| 35 | Consolidate Duplicate Conditional Fragments | Simplifying Conditionals | [techniques/simplifying-conditionals/consolidate-duplicate-conditional-fragments.md](techniques/simplifying-conditionals/consolidate-duplicate-conditional-fragments.md) |
| 36 | Remove Control Flag | Simplifying Conditionals | [techniques/simplifying-conditionals/remove-control-flag.md](techniques/simplifying-conditionals/remove-control-flag.md) |
| 37 | Replace Nested Conditional with Guard Clauses | Simplifying Conditionals | [techniques/simplifying-conditionals/replace-nested-conditional-with-guard-clauses.md](techniques/simplifying-conditionals/replace-nested-conditional-with-guard-clauses.md) |
| 38 | Replace Conditional with Polymorphism | Simplifying Conditionals | [techniques/simplifying-conditionals/replace-conditional-with-polymorphism.md](techniques/simplifying-conditionals/replace-conditional-with-polymorphism.md) |
| 39 | Introduce Null Object | Simplifying Conditionals | [techniques/simplifying-conditionals/introduce-null-object.md](techniques/simplifying-conditionals/introduce-null-object.md) |
| 40 | Introduce Assertion | Simplifying Conditionals | [techniques/simplifying-conditionals/introduce-assertion.md](techniques/simplifying-conditionals/introduce-assertion.md) |
| 41 | Rename Method | Simplifying Method Calls | [techniques/simplifying-method-calls/rename-method.md](techniques/simplifying-method-calls/rename-method.md) |
| 42 | Add Parameter | Simplifying Method Calls | [techniques/simplifying-method-calls/add-parameter.md](techniques/simplifying-method-calls/add-parameter.md) |
| 43 | Remove Parameter | Simplifying Method Calls | [techniques/simplifying-method-calls/remove-parameter.md](techniques/simplifying-method-calls/remove-parameter.md) |
| 44 | Separate Query from Modifier | Simplifying Method Calls | [techniques/simplifying-method-calls/separate-query-from-modifier.md](techniques/simplifying-method-calls/separate-query-from-modifier.md) |
| 45 | Parameterize Method | Simplifying Method Calls | [techniques/simplifying-method-calls/parameterize-method.md](techniques/simplifying-method-calls/parameterize-method.md) |
| 46 | Replace Parameter with Explicit Methods | Simplifying Method Calls | [techniques/simplifying-method-calls/replace-parameter-with-explicit-methods.md](techniques/simplifying-method-calls/replace-parameter-with-explicit-methods.md) |
| 47 | Preserve Whole Object | Simplifying Method Calls | [techniques/simplifying-method-calls/preserve-whole-object.md](techniques/simplifying-method-calls/preserve-whole-object.md) |
| 48 | Replace Parameter with Method Call | Simplifying Method Calls | [techniques/simplifying-method-calls/replace-parameter-with-method-call.md](techniques/simplifying-method-calls/replace-parameter-with-method-call.md) |
| 49 | Introduce Parameter Object | Simplifying Method Calls | [techniques/simplifying-method-calls/introduce-parameter-object.md](techniques/simplifying-method-calls/introduce-parameter-object.md) |
| 50 | Remove Setting Method | Simplifying Method Calls | [techniques/simplifying-method-calls/remove-setting-method.md](techniques/simplifying-method-calls/remove-setting-method.md) |
| 51 | Hide Method | Simplifying Method Calls | [techniques/simplifying-method-calls/hide-method.md](techniques/simplifying-method-calls/hide-method.md) |
| 52 | Replace Constructor with Factory Method | Simplifying Method Calls | [techniques/simplifying-method-calls/replace-constructor-with-factory-method.md](techniques/simplifying-method-calls/replace-constructor-with-factory-method.md) |
| 53 | Replace Error Code with Exception | Simplifying Method Calls | [techniques/simplifying-method-calls/replace-error-code-with-exception.md](techniques/simplifying-method-calls/replace-error-code-with-exception.md) |
| 54 | Replace Exception with Test | Simplifying Method Calls | [techniques/simplifying-method-calls/replace-exception-with-test.md](techniques/simplifying-method-calls/replace-exception-with-test.md) |
| 55 | Pull Up Field | Generalization | [techniques/generalization/pull-up-field.md](techniques/generalization/pull-up-field.md) |
| 56 | Pull Up Method | Generalization | [techniques/generalization/pull-up-method.md](techniques/generalization/pull-up-method.md) |
| 57 | Pull Up Constructor Body | Generalization | [techniques/generalization/pull-up-constructor-body.md](techniques/generalization/pull-up-constructor-body.md) |
| 58 | Push Down Method | Generalization | [techniques/generalization/push-down-method.md](techniques/generalization/push-down-method.md) |
| 59 | Push Down Field | Generalization | [techniques/generalization/push-down-field.md](techniques/generalization/push-down-field.md) |
| 60 | Extract Subclass | Generalization | [techniques/generalization/extract-subclass.md](techniques/generalization/extract-subclass.md) |
| 61 | Extract Superclass | Generalization | [techniques/generalization/extract-superclass.md](techniques/generalization/extract-superclass.md) |
| 62 | Extract Interface | Generalization | [techniques/generalization/extract-interface.md](techniques/generalization/extract-interface.md) |
| 63 | Collapse Hierarchy | Generalization | [techniques/generalization/collapse-hierarchy.md](techniques/generalization/collapse-hierarchy.md) |
| 64 | Form Template Method | Generalization | [techniques/generalization/form-template-method.md](techniques/generalization/form-template-method.md) |
| 65 | Replace Inheritance with Delegation | Generalization | [techniques/generalization/replace-inheritance-with-delegation.md](techniques/generalization/replace-inheritance-with-delegation.md) |
| 66 | Replace Delegation with Inheritance | Generalization | [techniques/generalization/replace-delegation-with-inheritance.md](techniques/generalization/replace-delegation-with-inheritance.md) |

---

## Quick Decision Guide

**Smell → Technique mapping** (most common fixes):

| If you see... | Try... |
|---------------|--------|
| Long Method | Extract Method, Replace Temp with Query, Replace Method with Method Object |
| Large Class | Extract Class, Extract Subclass, Extract Interface |
| Primitive Obsession | Replace Data Value with Object, Replace Type Code with Class/Subclasses/State-Strategy, Introduce Parameter Object |
| Long Parameter List | Preserve Whole Object, Introduce Parameter Object, Replace Parameter with Method Call |
| Data Clumps | Extract Class, Introduce Parameter Object, Preserve Whole Object |
| Switch Statements | Replace Conditional with Polymorphism, Replace Type Code with Subclasses/State-Strategy |
| Duplicate Code | Extract Method, Pull Up Method, Form Template Method |
| Feature Envy | Move Method, Extract Method |
| Message Chains | Hide Delegate, Extract Method, Move Method |
| Middle Man | Remove Middle Man, Inline Method, Replace Delegation with Inheritance |
| Divergent Change | Extract Class |
| Shotgun Surgery | Move Method, Move Field, Inline Class |
