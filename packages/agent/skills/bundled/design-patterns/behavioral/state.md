# State

## Intent

Let an object alter its behavior when its internal state changes. It appears as if the object changed its class.

## Problem

The State pattern is closely related to the concept of a Finite-State Machine. The main idea is that, at any given moment, there's a finite number of states which a program can be in. Within any unique state, the program behaves differently, and can be switched from one state to another instantaneously.

Consider a Document class that can be in one of three states: Draft, Moderation, and Published. The `publish` method works differently in each state:
- In Draft, it moves the document to moderation.
- In Moderation, it makes the document public (but only if the current user is an administrator).
- In Published, it does nothing.

State machines are usually implemented with many conditional operators (`if` or `switch`) that select the appropriate behavior depending on the current state. This "state" is usually just a set of values of the object's fields. The biggest weakness of this approach is that, as you add more states or state-dependent behaviors, the conditionals become monstrous, hard to maintain, and riddled with duplication.

## Solution

The State pattern suggests creating new classes for all possible states of an object and extracting all state-specific behaviors into those classes.

Instead of implementing all behaviors on its own, the original object (called *context*) stores a reference to one of the state objects that represents its current state and delegates all state-related work to that object.

To transition the context into another state, replace the active state object with another object representing the new state. This is possible only if all state classes follow the same interface and the context itself works with these objects through that interface.

**Key difference from Strategy:** In Strategy, strategies are almost never aware of each other. In State, concrete states may know about each other and initiate transitions from one state to another.

## Structure

- **Context** — stores a reference to one of the concrete state objects and delegates state-specific work to it. Communicates with the state object via the state interface. Exposes a setter for passing it a new state object.
- **State** (interface) — declares the state-specific methods. These methods should make sense for all concrete states because you don't want some states to have useless methods that will never be called.
- **Concrete States** — provide their own implementations for the state-specific methods. To avoid duplication across states, you may provide intermediate abstract classes that encapsulate common behavior. States may store a backreference to the context object to fetch required info and initiate state transitions.

## Applicability

- Use when you have an object that behaves differently depending on its current state, the number of states is enormous, and the state-specific code changes frequently.
- Use when you have a class polluted with massive conditionals that alter how the class behaves according to the current values of the class's fields.
- Use when you have a lot of duplicate code across similar states and transitions of a condition-based state machine.

## How to Implement

1. Decide which class will act as the context. It could be an existing class that already has state-dependent code, or a new class if the state-specific code is distributed across multiple classes.
2. Declare the state interface. Although it may mirror all methods declared in the context, aim only for those that may contain state-specific behavior.
3. For every actual state, create a class that derives from the state interface. Go over the context's methods and extract all code related to that state into the new class.
4. In the context class, add a reference field of the state interface type and a public setter that allows overriding the value of that field.
5. Go over the context's methods again and replace empty state conditionals with calls to corresponding methods of the state object.
6. To switch the context's state, create an instance of one of the state classes and pass it to the context. You can do this within the context itself, in various states, or in the client.

## Pros and Cons

**Pros:**
- *Single Responsibility Principle* — organize the code related to particular states into separate classes.
- *Open/Closed Principle* — introduce new states without changing existing state classes or the context.
- Simplify the code of the context by eliminating bulky state machine conditionals.

**Cons:**
- Applying the pattern can be overkill if a state machine has only a few states or rarely changes.

## Relations with Other Patterns

- **Bridge, State, Strategy (and to some degree Adapter)** have very similar structures. All of these patterns are based on composition — delegating work to other objects. However, they all solve different problems.
- **State** can be considered an extension of **Strategy**. Both patterns are based on composition. However, in Strategy, strategies are independent and unaware of each other. In State, concrete states may know about each other and initiate transitions.
- **State** is often used with **Flyweight** to share state objects among multiple contexts.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/state)*
