# Command

**Also known as:** Action, Transaction

## Intent

Turns a request into a stand-alone object that contains all information about the request. This transformation lets you parameterize methods with different requests, delay or queue a request's execution, and support undoable operations.

## Problem

You're building a text editor with a toolbar full of buttons. You create a base `Button` class and plan to subclass it for every toolbar action. Soon the number of subclasses explodes. Worse, some operations (copy, paste) are triggered from multiple places — toolbar buttons, context menus, keyboard shortcuts — leading to duplicate code in unrelated classes, or awkward dependencies between GUI and business logic layers.

## Solution

Extract the request details into a separate **command** object that implements a common interface (typically a single `execute` method). GUI elements don't perform work directly — they trigger a command. The command object holds all the parameters needed and delegates execution to the appropriate business logic object (the receiver).

This layer of indirection decouples the sender (GUI, scheduler, script) from the receiver (business logic). Commands become first-class objects that can be serialized, stored in history for undo, composed into macros, or sent across a network.

## Structure

- **Sender (Invoker)** — responsible for initiating requests. Stores a reference to a command object and triggers it instead of sending the request directly to the receiver.
- **Command interface** — declares the execution method (and often an undo method).
- **Concrete Commands** — implement the command interface. Each command stores the parameters needed and a reference to the receiver. The execute method delegates actual work to the receiver.
- **Receiver** — contains the business logic. Any object can act as a receiver.
- **Client** — creates concrete command objects, configures them with receivers and parameters, and associates them with senders.

## Applicability

- When you want to parameterize objects with operations — pass commands as method arguments, store them, or switch them at runtime.
- When you want to queue operations, schedule their execution, or execute them remotely.
- When you want to implement reversible (undo/redo) operations. Store executed commands in a history stack; to undo, pop and call the reverse method.

## How to Implement

1. Declare the command interface with a single execution method.
2. Extract requests into concrete command classes implementing the interface. Each class should have fields for the request arguments and a reference to the receiver.
3. Identify sender classes. Add fields to store commands. Senders should communicate with commands only via the command interface. Senders typically receive pre-created command objects from the client.
4. Change senders to trigger the command instead of sending a request to the receiver directly.
5. The client should initialize objects in the following order:
   - Create receivers.
   - Create commands and associate them with receivers.
   - Create senders and associate them with specific commands.

## Pros and Cons

**Pros:**
- *Single Responsibility Principle* — decouple classes that invoke operations from classes that perform them.
- *Open/Closed Principle* — introduce new commands without breaking existing code.
- Implement undo/redo.
- Implement deferred execution.
- Assemble simple commands into complex composite commands (macros).

**Cons:**
- Code may become more complicated since you introduce a whole new layer between senders and receivers.

## Relations with Other Patterns

- **Chain of Responsibility** — handlers can be implemented as commands; or commands can be the requests passed down a chain.
- **Mediator** — addresses how senders and receivers communicate. Command establishes unidirectional connections; Mediator eliminates direct connections entirely.
- **Observer** — Command establishes a one-to-one connection; Observer enables dynamic one-to-many notifications.
- **Memento** — can be used alongside Command for undo. Commands perform operations; mementos save the state just before a command executes.
- **Strategy** — both encapsulate an algorithm behind an interface, but commands can have state, support undo, and be serialized. Strategy objects are usually stateless and interchangeable.
- **Prototype** — useful when you need to save copies of commands into history.
- **Visitor** — can be treated as a powerful version of Command that operates on different object types.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/command)*
