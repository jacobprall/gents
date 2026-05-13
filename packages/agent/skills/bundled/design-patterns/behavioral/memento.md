# Memento

**Also known as:** Snapshot

## Intent

Save and restore the previous state of an object without revealing the details of its implementation.

## Problem

You're building a text editor that supports undo. The straightforward approach is to record state snapshots before every operation. To produce a snapshot, you'd need to copy all of an object's private fields — but that requires either making them public (breaking encapsulation) or coupling the snapshot mechanism tightly to the class internals. Either way, future refactoring of the class's private state breaks every piece of code that depends on the snapshot format. Other classes become fragile because they know too much about the editor's internals.

## Solution

Delegate the production of state snapshots to the actual owner of that state — the **originator**. Instead of outside code trying to copy the editor's state, the editor itself creates a snapshot because it has full access to its own private fields.

The snapshot is stored in a special object called a **memento**. The memento's contents are accessible only to the originator that produced it; other objects interact with the memento through a limited interface that exposes only metadata (creation time, operation name, etc.), not the stored state.

A **caretaker** (such as a command history) manages the collection of mementos. It knows when to ask the originator for a snapshot and when to restore from one, but it never inspects or modifies the memento's contents.

### Implementation Variations

1. **Nested classes** — the memento class is nested inside the originator, giving the originator access to private memento fields while hiding them from everything else.
2. **Intermediate interface** — the caretaker works with a narrow memento interface (metadata only), while the originator uses the full implementation.
3. **Strict encapsulation** — even the originator can't tamper with a previously created memento; restoration goes through the memento itself or a dedicated restorer.

## Structure

- **Originator** — produces snapshots of its own state and can restore its state from a memento.
- **Memento** — a value object acting as a snapshot of the originator's state. Typically immutable; populated once via the constructor.
- **Caretaker** — knows *when* and *why* to capture and restore the originator's state. Stores a stack or list of mementos. Never examines or depends on the memento's content.

## Applicability

- When you need to produce snapshots of an object's state to be able to restore a previous state (undo/redo, checkpoints, rollbacks).
- When direct access to the object's fields, getters, or setters violates encapsulation.

## How to Implement

1. Determine which class will play the role of originator.
2. Create the memento class. Declare a set of fields mirroring the originator's fields that need to be snapshotted.
3. Make the memento class immutable. It should accept data once, via constructor parameters, and provide no setters.
4. If your language supports nested classes, nest the memento inside the originator. If not, extract a narrow interface from the memento class and make all other objects use it.
5. Add a method to the originator that produces mementos. The originator passes its state to the memento's constructor.
6. Add a method to the originator that restores its state from a memento object.
7. The caretaker (command history, editor, etc.) should know when to request new mementos, how to store them, and when to restore from one.
8. The link between caretaker and originator can be moved into the memento itself — each memento references the originator that created it, enabling restore via a method on the memento.

## Pros and Cons

**Pros:**
- Produce snapshots of state without violating encapsulation.
- Simplify the originator's code by letting the caretaker maintain history.

**Cons:**
- High RAM consumption if clients create mementos too frequently.
- Caretakers should track the originator's lifecycle to destroy obsolete mementos.
- Dynamic languages (PHP, Python, JavaScript) can't guarantee the memento's state stays untouched.

## Relations with Other Patterns

- **Command** — use together to implement undo. Commands perform operations; mementos save the state just before a command executes. To undo, restore the memento.
- **Iterator** — can use mementos to capture the current iteration state and roll back if necessary.
- **Prototype** — sometimes a simpler alternative to Memento: if the state object is relatively simple, cloning via Prototype may suffice.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/memento)*
