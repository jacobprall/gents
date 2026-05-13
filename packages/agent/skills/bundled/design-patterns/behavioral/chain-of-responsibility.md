# Chain of Responsibility

**Also known as:** CoR, Chain of Command

## Intent

Pass requests along a chain of handlers. Upon receiving a request, each handler decides either to process the request or to pass it to the next handler in the chain.

## Problem

Imagine building an online ordering system. You need to perform sequential access checks: authentication, validation, caching, and rate throttling. Over time, these checks multiply. Adding each check as a conditional in the main processing code creates a tangled, fragile mess. The checks become hard to reuse elsewhere, and modifying one check risks breaking others. The ordering of checks matters, yet the code gives no clear way to control or rearrange that sequence.

## Solution

Extract each check into a standalone object called a **handler**. Each handler implements a common interface with a single method for processing requests and a reference to the next handler in the chain.

When a request arrives, each handler can either:
- Process the request and stop the chain, or
- Pass the request to the next handler.

There are two common approaches:
1. **All handlers process** — every handler in the chain gets a chance to act on the request (e.g., middleware stacks).
2. **First capable handler processes** — the chain stops at the first handler that can deal with the request (e.g., GUI event bubbling up the component tree).

A handler can also decide to halt propagation entirely, preventing downstream handlers from executing.

## Structure

- **Handler** — declares the interface common to all handlers; usually contains a single method for handling requests plus an optional method for setting the next handler.
- **Base Handler** — optional abstract class holding boilerplate shared by all handlers (storing a reference to the next handler, default forwarding logic).
- **Concrete Handlers** — contain the actual processing logic. Each handler decides whether to process a request and whether to pass it along the chain.
- **Client** — composes the chain (either once or dynamically) and triggers requests by sending them to any handler in the chain, not necessarily the first one.

## Applicability

- When your program needs to process different kinds of requests in various ways, but the exact types of requests and their sequences are unknown beforehand.
- When it's essential to execute several handlers in a particular order.
- When the set of handlers and their order should be changeable at runtime.

## How to Implement

1. Declare the handler interface with a method for handling requests. Decide whether the method accepts the request as a parameter or encapsulates it.
2. Create an abstract base handler class. Add a field for storing a reference to the next handler and implement default forwarding behavior.
3. Create concrete handler subclasses one by one. Each handler should make two decisions upon receiving a request:
   - Whether it will process the request.
   - Whether it will pass the request along the chain.
4. The client may assemble chains on its own or receive pre-built chains from other objects. Implement a factory or builder if chains vary by context.
5. The client may trigger any handler in the chain, not just the first one. The request will travel the chain until some handler refuses to pass it further or until it reaches the end.
6. Due to the dynamic nature of the chain, be prepared to handle the case where a request reaches the end without being processed.

## Pros and Cons

**Pros:**
- *Single Responsibility Principle* — decouple classes that invoke operations from classes that perform them.
- *Open/Closed Principle* — introduce new handlers without breaking existing client code.
- Control the order of request handling.

**Cons:**
- Some requests may end up unhandled if the chain is misconfigured or incomplete.

## Relations with Other Patterns

- **Command** — handlers can be implemented as commands. You can also use commands as the requests themselves.
- **Mediator** — eliminates direct dependencies between request senders and receivers. Chain of Responsibility passes a request along a dynamic chain; Mediator centralizes communication.
- **Observer** — lets receivers dynamically subscribe to and unsubscribe from receiving requests. Chain of Responsibility passes along a fixed (at runtime) chain.
- **Composite** — leaf components can pass requests up through the parent chain, which is a form of Chain of Responsibility.
- **Decorator** — both have recursive composition, but Decorator adds responsibilities while CoR can independently halt propagation.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/chain-of-responsibility)*
